#! /usr/local/bin/Rscript
library(tidyverse)
library(patchwork)
setwd("~/Documents/Koszul/__Bioinfo/repos/chromosomix/notebooks/")

# The timing notebook's two tables, as chromosomix.app/timings publishes them
download.file("https://chromosomix.app/timings/timings.tsv", "timing_results.tsv")
download.file("https://chromosomix.app/timings/viewers.tsv", "viewers_results.tsv")

APP <- "#2b6fd6"
REF <- "#e8622c"
TYPES <- c(`1D` = "#2b6fd6", `2D` = "#f2c14e", `3D` = "#9b4dca")

everything <- read_tsv("timing_results.tsv") |>
    mutate(side = if_else(tool == "chromosomix", "chromosomix", "reference")) |>
    group_by(section) |>
    mutate(pair = if (n_distinct(group[side == "chromosomix"]) == 1) group[side == "chromosomix"][1] else group) |>
    ungroup()
dat <- everything |>
    # One variant a task is enough, but for P(s) on two genomes; and the analyses up to §19, with
    # §24's five steps on GM12878 and Pairs QC (§27)
    filter(
        section <= 19 | section %in% c(24, 27),
        !(section == 9 & pair == "raw"),
        !(section == 11 & pair != "raw"),
        !(section == 14 & pair == "TSS"),
        !(section == 17 & pair == "WGATAR"),
        !(section == 18 & pair != "100 bp windows")
    )

jobs <- dat |>
    group_by(section, analysis, pair, side, run) |>
    summarise(
        tool = paste(unique(tool), collapse = ", "), order = min(order),
        cpu = sum(cpu_s), mem = max(peak_mb), .groups = "drop"
    )

folds <- jobs |>
    group_by(section, analysis, pair) |>
    summarise(
        order = min(order), reference = tool[side == "reference"][1],
        CPU = mean(cpu[side == "reference"]) / mean(cpu[side == "chromosomix"]),
        # Each side's largest run, as the notebook's table reports them
        memory = max(mem[side == "reference"]) / max(mem[side == "chromosomix"]),
        .groups = "drop"
    )

# What each pair runs on, from its data, the pair's own variant first ("chr1", "100 bp windows"),
# read for every section, as one shown may be described by one that is not
meta <- everything |>
    distinct(section, analysis, pair, data) |>
    mutate(
        # §4 holds two datasets, "yeast …; mouse …": keep the pair's
        data = map2_chr(str_split(data, "; "), pair, \(d, p) if (length(d) == 1) d else d[str_starts(d, word(p))][1]),
        info = str_c(replace_na(pair, ""), "; ", data),
        genome = str_extract(info, "mouse|yeast|chicken|mm10"),
        `data type` = str_extract(data, "ATAC-seq|Micro-C|Hi-C|mm10|R64-1-1"),
        resolution = str_extract(info, "(?<=^|, |-C )[\\d,.]+ (bp|kb)") |> replace_na("1 bp") |> str_remove(" "),
        # Metaplots are drawn in steps of 50 bp, which their data do not say
        resolution = if_else(section == 14, "50bp", resolution),
        scope = str_extract(info, "chr\\d+") |> replace_na("genome")
    ) |>
    # Data described by another section's ("§ 25's contact list") are that section's genome and type
    mutate(
        from = match(as.numeric(str_extract(data, "(?<=§ )\\d+")), section),
        genome = coalesce(genome, genome[from]) |>
            recode(yeast = "yeast, 12 Mb", chicken = "chicken, 1.2 Gb", mouse = "mouse, 2.7 Gb", mm10 = "mouse, 2.7 Gb"),
        `data type` = coalesce(`data type`, `data type`[from]) |> recode(mm10 = "DNA seq.", `R64-1-1` = "DNA seq.")
    ) |>
    select(-from) |>
    # §24's steps share one description: what each reads, on chr19 of GM12878
    rows_update(
        tribble(
            ~pair, ~`data type`, ~resolution,
            "insulation", "Hi-C", "10kb",
            "APA", "Hi-C", "10kb",
            "peaks", "ChIP-seq", "1bp",
            "metaplot, signal", "ChIP, ATAC", "50bp",
            "metaplot, insulation", "insulation", "10kb"
        ) |>
            mutate(section = 24, genome = "human, 3.1 Gb", scope = "chr19"),
        by = c("section", "pair")
    ) |>
    mutate(type = case_when(str_detect(analysis, "3D") ~ "3D", `data type` %in% c("Hi-C", "Micro-C") ~ "2D", .default = "1D"))

# One line a pair, shared by every panel: 1D tasks on top, then 2D, then 3D
rows <- folds |>
    left_join(select(meta, section, analysis, pair, type), by = c("section", "analysis", "pair")) |>
    # Loop calling just before chromosight's loops, as in the app, though the notebook times it last
    mutate(order = if_else(analysis == "Loop calling", min(order[analysis == "Loops (chromosight)"]) - 0.5, order)) |>
    arrange(desc(type), desc(order)) |>
    # The task's name, with its variant only when it has several
    mutate(
        task = if (section[1] == 24) {
            str_c(recode(pair,
                insulation = "Diamond insulation", peaks = "Peak calling", APA = "Aggregate peak analysis",
                `metaplot, signal` = "Metaplot, signal", `metaplot, insulation` = "Metaplot, insulation"
            ), ", GM12878")
        } else {
            analysis |>
                str_remove(" \\(.*\\)") |>
                recode(`APA, chromosight's score` = "Aggregate peak analysis", `Boost-HiC` = "Upsampling", `3D model` = "3D reconstruction")
        },
        # pandas, the notebook's own arithmetic, is no reference tool
        versus = reference |> str_remove(" [\\d.]+$") |> str_remove(", pandas") |> str_replace_all(", ", " + "),
        label = str_c(task, if (n() > 1 && section[1] != 24) str_c(", ", pair) else "", " (vs ", versus, ")"),
        .by = section
    ) |>
    mutate(
        label = fct_inorder(label),
        shade = as.integer(label) %% 2 == 0
    ) |>
    select(section, analysis, pair, type, label, shade)
meta <- meta |>
    inner_join(select(rows, -type), by = c("section", "analysis", "pair")) |>
    pivot_longer(c(genome, `data type`, resolution, scope)) |>
    mutate(name = fct_inorder(name))
jobs <- left_join(jobs, rows, by = c("section", "analysis", "pair"))
folds <- left_join(folds, rows, by = c("section", "analysis", "pair"))

# Folds are ratios, so their mean is geometric
caption <- with(folds, sprintf(
    "On average, chromosomix runs %.1f× faster than the reference tools (CPU time) and uses %.1f× less peak memory (geometric means over the %d comparisons in b).",
    exp(mean(log(CPU))), exp(mean(log(memory))), nrow(folds)
))
message(caption)

# Viewers: seconds from handing a viewer a map and a track to its picture being finished
viewers <- read_tsv("viewers_results.tsv") |>
    filter(!is.na(seconds)) |>
    mutate(
        viewer = str_c(recode(viewer, juicebox = "juicebox.js", higlass = "HiGlass"), " (.", format, ")"),
        where = fct_inorder(recode(location, local = "From disk", cloud = "From cloud")),
        label = fct_rev(fct_inorder(str_c(genome, " · ", view)))
    )

# One line a picture: a genome, and a window of it at one resolution
pictures <- viewers |>
    distinct(label, genome, view, window, resolution, bins) |>
    mutate(
        shade = as.integer(label) %% 2 == 0,
        genome = recode(genome, yeast = "yeast, 12 Mb", chicken = "chicken, 1.2 Gb", mouse = "mouse, 2.7 Gb"),
        resolution = case_when(
            resolution >= 1e6 ~ str_c(resolution / 1e6, "Mb"),
            resolution >= 1e3 ~ str_c(resolution / 1e3, "kb"),
            .default = str_c(resolution, "bp")
        )
    )

# Nothing drawn but what shows: no backgrounds, no empty boxes
bare <- theme(
    plot.background = element_blank(), panel.background = element_blank(),
    legend.background = element_blank(), legend.key = element_blank()
)

# Every other line shaded, under any panel whose lines are `rows`
common <- function(rows) {
    list(
        geom_rect(
            aes(ymin = as.numeric(label) - 0.5, ymax = as.numeric(label) + 0.5),
            data = filter(rows, shade), xmin = -Inf, xmax = Inf, inherit.aes = FALSE, fill = "grey94"
        ),
        labs(y = NULL, colour = NULL),
        theme_bw(base_size = 7),
        theme(panel.grid.major.y = element_blank(), panel.grid.minor = element_blank()),
        bare
    )
}

# What each line is, as a table with its headers on top
table_of <- function(cells, rows) {
    ggplot(cells, aes(name, label, label = value)) +
        common(rows) +
        geom_text(size = 1.9, colour = "grey20") +
        scale_x_discrete(position = "top") +
        labs(x = NULL) +
        theme(panel.border = element_blank(), panel.grid = element_blank(), axis.ticks = element_blank(), axis.text.x.top = element_text(face = "bold"))
}

# The mean or median of the runs, a vertical bar: an error bar from it to itself
bar <- function(summary, ...) {
    stat_summary(
        fun = summary, fun.min = summary, fun.max = summary, geom = "errorbar",
        orientation = "y", linewidth = 0.7, show.legend = FALSE, ...
    )
}

# Every run a dot, the mean a bar
runs <- function() {
    list(
        geom_point(alpha = 0.5, size = 1, key_glyph = "pointrange"),
        bar(mean, width = 0.6)
    )
}

# a: the viewers
dodge <- position_dodge(width = 0.8, orientation = "y")
v_names <- ggplot(pictures, aes(0.97, label)) +
    common(pictures) +
    geom_text(aes(label = view), hjust = 1, size = 2.1, fontface = "bold") +
    scale_x_continuous(limits = c(0, 1), expand = c(0, 0)) +
    theme_void()
v_grid <- pictures |>
    select(label, genome, window, resol. = resolution, bins) |>
    pivot_longer(-label, values_transform = as.character) |>
    mutate(name = fct_inorder(name)) |>
    table_of(pictures)
v_seconds <- ggplot(viewers, aes(seconds, label, colour = viewer, group = viewer)) +
    common(pictures) +
    geom_point(alpha = 0.5, size = 1, position = dodge, key_glyph = "pointrange") +
    bar(median, width = 0.7, position = dodge) +
    facet_wrap(~where, strip.position = "bottom") +
    scale_colour_manual(
        values = c(`chromosomix (.hic)` = "#7fb0ea", `juicebox.js (.hic)` = REF, `chromosomix (.mcool)` = APP, `HiGlass (.mcool)` = "#4f9d69"),
        breaks = c("chromosomix (.hic)", "juicebox.js (.hic)", "chromosomix (.mcool)", "HiGlass (.mcool)")
    ) +
    # The limits are the data's, wide enough for the first and last ticks
    scale_x_log10(breaks = c(0.3, 1, 3, 10, 30), limits = range(viewers$seconds, 0.25, 30)) +
    labs(x = "Time to rendered picture") +
    theme(strip.placement = "outside", strip.background = element_blank(), strip.text = element_text(face = "bold"))
a <- v_names + v_grid + v_seconds +
    plot_layout(widths = c(1, 3.2, 6.3), guides = "collect") &
    theme(legend.position = "top", legend.box.spacing = unit(0, "pt"), axis.text.y = element_blank(), axis.ticks.y = element_blank())

# b: the tasks, chromosomix against its reference
names <- ggplot(rows, aes(0.98, label)) +
    geom_rect(
        aes(ymin = as.numeric(label) - 0.5, ymax = as.numeric(label) + 0.5, fill = type),
        xmin = -Inf, xmax = Inf, alpha = 0.2, show.legend = FALSE
    ) +
    geom_text(aes(label = label), hjust = 1, size = 2, fontface = "bold", colour = "grey20") +
    geom_text(
        aes(0.02, y, label = type, colour = type),
        data = summarise(rows, y = mean(as.numeric(label)), .by = type),
        hjust = 0, size = 3.5, fontface = "bold", show.legend = FALSE
    ) +
    scale_fill_manual(values = TYPES) +
    scale_colour_manual(values = TYPES) +
    scale_x_continuous(limits = c(0, 1), expand = c(0, 0)) +
    theme_void()
grid <- table_of(meta, rows) +
    theme(axis.text.x.top = element_text(angle = 45, hjust = 0, vjust = 0))
sides <- scale_colour_manual(values = c(chromosomix = APP, reference = REF))
cpu <- ggplot(jobs, aes(cpu, label, colour = side)) +
    common(rows) +
    runs() +
    sides +
    scale_x_log10() +
    labs(x = "CPU time (s)")
memory <- ggplot(jobs, aes(mem, label, colour = side)) +
    common(rows) +
    runs() +
    sides +
    scale_x_log10() +
    labs(x = "Peak memory (MB)")
b <- names + grid + cpu + memory +
    plot_layout(widths = c(3.2, 3.3, 2.6, 2.6), guides = "collect") &
    theme(legend.position = "top", legend.box.spacing = unit(0, "pt"), axis.text.y = element_blank(), axis.ticks.y = element_blank())

# c: CPU against memory, one point a pair: top right is faster and lighter than the reference
# Each label on two lines, the task above its reference, for the room 26 of them need
c <- ggplot(folds, aes(CPU, memory, label = str_replace(as.character(label), " \\(vs ", "\n(vs "))) +
    geom_hline(yintercept = 1, linetype = "dashed", colour = "grey40") +
    geom_vline(xintercept = 1, linetype = "dashed", colour = "grey40") +
    geom_point(aes(fill = type), shape = 21, colour = "black", size = 3, stroke = 0.5, show.legend = FALSE) +
    ggrepel::geom_text_repel(
        # P(s) on yeast sits in the crowd: left alone, its label lands on the Pairs QC point
        nudge_x = if_else(str_detect(folds$label, "yeast"), -0.08, 0),
        nudge_y = if_else(str_detect(folds$label, "yeast"), 0.27, 0),
        size = 2.6, lineheight = 0.85, colour = "grey20", min.segment.length = 0, box.padding = 0.5, point.padding = 0.5, point.size = 3,
        force = 3, max.overlaps = Inf, max.time = 5, max.iter = 1e5, seed = 1
    ) +
    scale_fill_manual(values = TYPES) +
    # Room left of and below the crowded points for their labels
    scale_x_log10(breaks = c(1, 2, 5, 10, 20, 50, 100), labels = \(x) str_c(x, "×"), expand = expansion(mult = c(0.12, 0.05))) +
    scale_y_log10(breaks = c(0.5, 1, 2, 5, 10, 20, 50), labels = \(x) str_c(x, "×"), expand = expansion(mult = c(0.2, 0.05))) +
    labs(x = "× faster than the reference (CPU time)", y = "× less peak memory than the reference") +
    theme_bw(base_size = 8) +
    bare +
    theme(panel.grid.minor = element_blank())

fig <- wrap_elements(full = a) / wrap_elements(full = b) / wrap_elements(full = c) +
    plot_layout(heights = c(1, 1.6, 1.45)) +
    plot_annotation(
        tag_levels = "a", caption = caption,
        theme = theme(plot.background = element_blank(), plot.caption = element_text(size = 8, hjust = 0))
    ) &
    theme(plot.tag = element_text(face = "bold", size = 12), plot.background = element_blank())

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
cairo_pdf("timing_results.pdf", width = 8.27, height = 11.69)
grid::grid.draw(unclip(patchworkGrob(fig)))
dev.off()

# The tables are only read here, and downloaded again at every run
unlink(c("timing_results.tsv", "viewers_results.tsv"))
