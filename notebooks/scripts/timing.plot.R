#! /usr/local/bin/Rscript
library(tidyverse)
library(patchwork)
setwd("~/Documents/Koszul/__Bioinfo/repos/chromosomix/notebooks/")

# The timings' table and the viewers', as chromosomix.app/timings and /viewers publish them, and the laptop's two of
# its deep human map, as chromosomix.app/laptop unpacks them from the committed page
download.file("https://chromosomix.app/timings/timings.tsv", "timing_results.tsv")
download.file("https://chromosomix.app/viewers/viewers.tsv", "viewers_results.tsv")
download.file("https://chromosomix.app/laptop/pipeline.tsv", "pipeline_results.tsv")
download.file("https://chromosomix.app/laptop/pipeline-memory.tsv", "pipeline_memory_results.tsv")

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
    # §24's five steps on GM12878
    filter(
        section <= 19 | section == 24,
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
        cpu = sum(cpu_s), wall = sum(wall_s), mem = max(peak_mb), .groups = "drop"
    )

folds <- jobs |>
    group_by(section, analysis, pair) |>
    summarise(
        order = min(order), reference = tool[side == "reference"][1],
        CPU = mean(cpu[side == "reference"]) / mean(cpu[side == "chromosomix"]),
        wall = mean(wall[side == "reference"]) / mean(wall[side == "chromosomix"]),
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

# The pipeline on a deep human map: each phase of each side, when it began and ended, and the whole,
# against the memory weighed while it ran
pipeline <- read_tsv("pipeline_results.tsv")
# Each side's mean over the runs, for the caption
whole <- pipeline |>
    filter(step == "total") |>
    summarise(wall = mean(wall_s), cpu = mean(cpu_s), .by = side)
minutes <- \(s) if_else(s >= 90, sprintf("%.1f min", s / 60), sprintf("%.0f s", s))

# Folds are ratios, so their mean is geometric
caption <- with(folds, sprintf(
    "On average, chromosomix runs %.1f× faster than the reference tools (CPU time), %.1f× faster on the wall clock, and uses %.1f× less peak memory (geometric means over the %d comparisons in b).",
    exp(mean(log(CPU))), exp(mean(log(wall))), exp(mean(log(memory))), nrow(folds)
))
caption <- str_c(caption, sprintf(
    " Loop calling, insulation, compartments, APA, P(s) and a virtual 4C over the IMR-90 map (c, on the laptop) take %s in chromosomix, on one thread, and %s in one Python script running cooltools and coolpuppy on %d processes (%.1f× on the wall clock, %.1f× in CPU time).",
    minutes(whole$wall[whole$side == "chromosomix"]), minutes(whole$wall[whole$side == "reference"]),
    max(pipeline$threads), whole$wall[whole$side == "reference"] / whole$wall[whole$side == "chromosomix"],
    whole$cpu[whole$side == "reference"] / whole$cpu[whole$side == "chromosomix"]
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
# CPU and wall-clock time on one axis, to read one against the other
seconds <- scale_x_log10(limits = range(jobs$cpu, jobs$wall))
cpu <- ggplot(jobs, aes(cpu, label, colour = side)) +
    common(rows) +
    runs() +
    sides +
    seconds +
    labs(x = "CPU time (s)")
wall <- ggplot(jobs, aes(wall, label, colour = side)) +
    common(rows) +
    runs() +
    sides +
    seconds +
    labs(x = "Wall-clock time (s)")
memory <- ggplot(jobs, aes(mem, label, colour = side)) +
    common(rows) +
    runs() +
    sides +
    scale_x_log10() +
    labs(x = "Peak memory (MB)")
b <- names + grid + cpu + wall + memory +
    plot_layout(widths = c(3.2, 3.3, 1.8, 1.8, 1.8), guides = "collect") &
    theme(legend.position = "top", legend.box.spacing = unit(0, "pt"), axis.text.y = element_blank(), axis.ticks.y = element_blank())

# c: the pipeline against the wall clock, its first run: the memory each side's processes held
# together, weighed every quarter of a second, each phase shaded behind it, its peak marked and where it
# finished. chromosomix's phases are its six commands back to back, each paying its own start-up
PHASES <- c(
    `start-up` = "#d9d9d9", loops = "#cfe3c1", insulation = "#f5e2ad", compartments = "#dcd2ec", apa = "#c6e2ea",
    ps = "#f4cfc7", fourc = "#e4d6c3"
)
phase_names <- pipeline |>
    distinct(step, task) |>
    deframe()
sided <- c(
    chromosomix = "chromosomix, 1 thread",
    reference = sprintf("cooltools and coolpuppy, %d processes", max(pipeline$threads))
)
first <- filter(pipeline, run == 1)
phases <- filter(first, step %in% names(PHASES), !is.na(from_s))
ends <- first |>
    filter(step == "total") |>
    transmute(side, end = to_s / 60)
weighed <- read_tsv("pipeline_memory_results.tsv") |>
    filter(run == 1) |>
    arrange(side, seconds)
# Where the weighings peak, labelled with the peak as the table gives it: never less than the largest
# resident set any one process reached, which a weighing can miss
peaks <- weighed |>
    slice_max(mb, n = 1, by = side, with_ties = FALSE) |>
    left_join(transmute(filter(first, step == "total"), side, most = peak_mb), by = "side") |>
    # Its first letter lowered, unless what follows it is not a small letter (APA, P(s))
    mutate(task = phase_names[step], task = if_else(
        str_detect(task, "^.[a-z]"), str_c(str_to_lower(str_sub(task, 1, 1)), str_sub(task, 2)), task
    ))
top <- max(weighed$mb) / 1024 * 1.3
c <- ggplot(weighed, aes(seconds / 60, mb / 1024)) +
    geom_rect(
        aes(xmin = from_s / 60, xmax = to_s / 60, ymin = -Inf, ymax = Inf, fill = step),
        data = phases, inherit.aes = FALSE, alpha = 0.6
    ) +
    geom_area(aes(colour = side, fill = after_scale(alpha(colour, 0.3))), linewidth = 0.3, outline.type = "upper") +
    geom_point(aes(colour = side), data = peaks, size = 1) +
    geom_text(
        aes(label = sprintf("peak %.1f GB, %s", most / 1024, task)),
        # Ending at the point, over its own phase, rather than across the line where the side finished
        data = peaks, hjust = 1, vjust = 0, nudge_x = -0.06, nudge_y = 0.25, size = 2, colour = "grey20"
    ) +
    geom_vline(aes(xintercept = end), data = ends, linetype = "22", linewidth = 0.3, colour = "grey30") +
    geom_text(
        aes(end, top * 0.94, label = str_c("done, ", minutes(end * 60))),
        data = ends, hjust = 0, vjust = 1, nudge_x = 0.08, size = 2, colour = "grey20", inherit.aes = FALSE
    ) +
    facet_wrap(~side, ncol = 1, labeller = as_labeller(sided)) +
    scale_fill_manual(values = PHASES, breaks = names(PHASES), labels = phase_names[names(PHASES)], name = NULL) +
    scale_colour_manual(values = c(chromosomix = APP, reference = REF), guide = "none") +
    scale_x_continuous(breaks = 0:60, limits = c(0, max(ends$end) * 1.16), expand = c(0, 0)) +
    scale_y_continuous(limits = c(0, top), expand = c(0, 0)) +
    labs(
        x = "Wall-clock time (min)", y = "Memory (GB)",
        title = "Human IMR-90 Hi-C (4DNFIJTOIGOI), 1.08 billion contacts, on the laptop"
    ) +
    theme_bw(base_size = 7) +
    bare +
    theme(
        panel.grid.minor = element_blank(), panel.grid.major.y = element_blank(), legend.position = "top",
        legend.key.size = unit(8, "pt"), legend.box.spacing = unit(0, "pt"), strip.background = element_blank(),
        strip.text = element_text(face = "bold", hjust = 0), plot.title = element_text(size = 6, colour = "grey20")
    )

# d and e: CPU time, then wall-clock time, against memory, one point a pair: top right is faster and
# lighter than the reference
# Each label on two lines, the task above its reference, for the room 26 of them need
against_memory <- function(time, clock, left = 0.12, nudge_x = 0, nudge_y = 0) {
    ggplot(folds, aes({{ time }}, memory, label = str_replace(as.character(label), " \\(vs ", "\n(vs "))) +
        geom_hline(yintercept = 1, linetype = "dashed", colour = "grey40") +
        geom_vline(xintercept = 1, linetype = "dashed", colour = "grey40") +
        geom_point(aes(fill = type), shape = 21, colour = "black", size = 3, stroke = 0.5, show.legend = FALSE) +
        ggrepel::geom_text_repel(
            nudge_x = nudge_x, nudge_y = nudge_y,
            size = 2.6, lineheight = 0.85, colour = "grey20", min.segment.length = 0, box.padding = 0.5, point.padding = 0.5, point.size = 3,
            force = 3, max.overlaps = Inf, max.time = 5, max.iter = 1e5, seed = 1
        ) +
        scale_fill_manual(values = TYPES) +
        # Room left of and below the crowded points for their labels
        scale_x_log10(breaks = c(0.5, 1, 2, 5, 10, 20, 50, 100), labels = \(x) str_c(x, "×"), expand = expansion(mult = c(left, 0.05))) +
        scale_y_log10(breaks = c(0.5, 1, 2, 5, 10, 20, 50), labels = \(x) str_c(x, "×"), expand = expansion(mult = c(0.2, 0.05))) +
        labs(x = str_c("× faster than the reference (", clock, ")"), y = "× less peak memory than the reference") +
        theme_bw(base_size = 8) +
        bare +
        theme(panel.grid.minor = element_blank())
}
# P(s) on yeast sits in d's crowd: left alone, its label lands on the Pairs QC point
yeast <- str_detect(folds$label, "yeast")
d <- against_memory(CPU, "CPU time", nudge_x = if_else(yeast, -0.08, 0), nudge_y = if_else(yeast, 0.27, 0))
# In e, Coverage, slower than cooltools on the wall clock, wants more room on the left for its label,
# and lifted; the label of the metaplot goes below the crowd at 1×, P(s) on yeast's above its own
metaplot <- str_detect(folds$label, "^Metaplot \\(")
coverage <- str_detect(folds$label, "^Coverage")
e <- against_memory(wall, "wall-clock time",
    left = 0.2,
    nudge_x = case_when(metaplot ~ 0.12, yeast ~ 0.1, .default = 0),
    nudge_y = case_when(metaplot ~ -0.2, yeast ~ 0.3, coverage ~ 0.25, .default = 0)
)

# Each panel in inches, as tall as it was when a, b and the first scatter shared an A4 page (595 × 841
# pt, the device rounding it down to whole points): the page grows to hold c and e. To the last digit,
# as ggrepel lays d's and e's labels out anew on any change to their size
fig <- wrap_elements(full = a) / wrap_elements(full = b) / wrap_elements(full = c) / wrap_elements(full = d) /
    wrap_elements(full = e) +
    plot_layout(heights = unit(2.534447638912377 * c(1, 1.6, 1.1, 1.45, 1.45), "in")) +
    plot_annotation(
        tag_levels = "a", caption = str_wrap(caption, 150),
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
# The page A4 wide, and as tall as the panels and what lies between and under them, the caption
# among it, measured on the device that draws it
cairo_pdf(tempfile(), width = 8.27, height = 11.69)
page <- unclip(patchworkGrob(fig))
height <- grid::convertHeight(sum(page$heights), "in", valueOnly = TRUE)
dev.off()
# The device rounds a page down to whole points, so up here; the figure laid from the page's top,
# what that adds is blank under the caption
cairo_pdf("timing_results.pdf", width = 8.27, height = ceiling(height * 72) / 72)
grid::pushViewport(grid::viewport(y = 1, height = unit(height, "in"), just = "top"))
grid::grid.draw(page)
dev.off()

# The tables are only read here, and downloaded again at every run
unlink(c("timing_results.tsv", "viewers_results.tsv", "pipeline_results.tsv", "pipeline_memory_results.tsv"))
