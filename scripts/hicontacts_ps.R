# HiContacts::distanceLaw(), as an oracle for metacooler.js's P(s).
#
# Run by `scripts/make_analysis_golden.py`, which hands it a table of
# (unit, k, n) — a curve's name, a separation in bins, and the raw contacts at
# that separation, counted once per unordered pair of bins — and gets back the
# columns `HiContacts::distanceLaw()` returns.
#
# **The pipeline below is copied line for line from js2264/HiContacts, R/Ps.R,
# at 8d361a67 ("bump to 1.13.1"), MIT-licensed, © Jacques Serizay**, as is
# `PsBreaks()`. Copying rather than calling is deliberate: an oracle that is a
# transcription of the thing it checks is worth less than one that is the thing
# itself, and the whole HiCExperiment/InteractionSet/rhdf5 stack is a heavy
# dependency for a test. What is *not* copied is the two lines that read the
# map, and they are the only substitution:
#
#     pairs    <- InteractionSet::interactions(x)
#     distance <- InteractionSet::pairdist(pairs, type = 'gap')
#
# becomes `distance <- (k - 1) * binsize`, read from the table. That identity is
# exact, not an approximation: HiCExperiment builds a cooler's bins as
# `IRanges(bins$start + 1, bins$end)` (R/parse-cool.R:61), so bin *i* spans
# [i·w + 1, (i+1)·w]; and InteractionSet's gap distance is
# `max(all.as, all.ts) - min(all.ae, all.te) - 1` (R/distances.R), which for two
# such bins k apart is (i+k)·w + 1 − (i+1)·w − 1 = (k − 1)·w. So offset 1 sits at
# 0 bp, the diagonal at −w, and both fall in the first break.
#
# Two columns of `distanceLaw()`'s output are left out, both because nothing in
# the app computes them. `slope` HiContacts forms as a forward difference of
# log10(norm_p) and then replaces with a loess fit of span 0.5; the app draws the
# *unsmoothed* central difference of the same curve (`logLogSlope`), so goldening
# the smoothed one would assert a correspondence that is deliberately not there.
# `norm_p_unity` is `norm_p` divided by its own value at the break nearest
# 100 kb, which is a rescaling of the curve below rather than a second curve.
# What is goldened is `norm_p`, which is what the panel plots.
#
# Needs R with dplyr, tibble and tidyr. The R install is the reason this is a
# separate file rather than a few lines of numpy: reproducing `findInterval(...,
# all.inside = TRUE)`, `left_join` and the group semantics in another language is
# how an oracle quietly becomes a second implementation of the thing it checks.

suppressPackageStartupMessages({
    library(dplyr)
    library(tibble)
    library(tidyr)
})

PsBreaks <- function() {
    structure(list(break_pos = c(
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
        12, 13, 14, 16, 17, 19, 21, 23, 26, 28, 31, 34, 37, 41, 45, 50,
        55, 60, 66, 73, 80, 88, 97, 107, 117, 129, 142, 156, 172, 189,
        208, 229, 252, 277, 304, 335, 368, 405, 446, 490, 539, 593, 653,
        718, 790, 869, 956, 1051, 1156, 1272, 1399, 1539, 1693, 1862,
        2048, 2253, 2479, 2726, 2999, 3299, 3629, 3992, 4391, 4830, 5313,
        5844, 6429, 7072, 7779, 8557, 9412, 10354, 11389, 12528, 13781,
        15159, 16675, 18342, 20176, 22194, 24413, 26855, 29540, 32494,
        35743, 39318, 43249, 47574, 52332, 57565, 63322, 69654, 76619,
        84281, 92709, 101980, 112178, 123396, 135735, 149309, 164240,
        180664, 198730, 218603, 240463, 264510, 290961, 320057, 352063,
        387269, 425996, 468595, 515455, 567000, 623700, 686070, 754677,
        830145, 913160, 1004475, 1104923, 1215415, 1336957, 1470653,
        1617718, 1779490, 1957439, 2153182, 2368501, 2605351, 2865886,
        3152474, 3467722, 3814494, 4195943, 4615538, 5077092, 5584801,
        6143281, 6757609, 7433370, 8176707, 8994377, 9893815, 10883197,
        11971516, 13168668, 14485535, 15934088, 17527497, 19280247, 21208271,
        23329099, 25662008, 28228209, 31051030, 34156133, 37571747, 41328921,
        45461813, 50007995, 55008794, 60509674, 66560641, 73216705, 80538375,
        88592213, 97451434, 107196578, 117916236, 129707859, 142678645,
        156946509, 172641160, 189905276, 208895804, 229785385, 252763923,
        278040315, 305844347, 336428781, 370071660, 407078826, 447786708,
        492565379, 541821917, 596004109, 655604519, 721164971, 793281468,
        872609615, 959870577, 1055857635, 1161443398
    ), binwidth = c(
        1,
        1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 2, 2, 2, 3, 2, 3, 3,
        3, 4, 4, 5, 5, 5, 6, 7, 7, 8, 9, 10, 10, 12, 13, 14, 16, 17,
        19, 21, 23, 25, 27, 31, 33, 37, 41, 44, 49, 54, 60, 65, 72, 79,
        87, 95, 105, 116, 127, 140, 154, 169, 186, 205, 226, 247, 273,
        300, 330, 363, 399, 439, 483, 531, 585, 643, 707, 778, 855, 942,
        1035, 1139, 1253, 1378, 1516, 1667, 1834, 2018, 2219, 2442, 2685,
        2954, 3249, 3575, 3931, 4325, 4758, 5233, 5757, 6332, 6965, 7662,
        8428, 9271, 10198, 11218, 12339, 13574, 14931, 16424, 18066,
        19873, 21860, 24047, 26451, 29096, 32006, 35206, 38727, 42599,
        46860, 51545, 56700, 62370, 68607, 75468, 83015, 91315, 100448,
        110492, 121542, 133696, 147065, 161772, 177949, 195743, 215319,
        236850, 260535, 286588, 315248, 346772, 381449, 419595, 461554,
        507709, 558480, 614328, 675761, 743337, 817670, 899438, 989382,
        1088319, 1197152, 1316867, 1448553, 1593409, 1752750, 1928024,
        2120828, 2332909, 2566201, 2822821, 3105103, 3415614, 3757174,
        4132892, 4546182, 5000799, 5500880, 6050967, 6656064, 7321670,
        8053838, 8859221, 9745144, 10719658, 11791623, 12970786, 14267864,
        15694651, 17264116, 18990528, 20889581, 22978538, 25276392, 27804032,
        30584434, 33642879, 37007166, 40707882, 44778671, 49256538, 54182192,
        59600410, 65560452, 72116497, 79328147, 87260962, 95987058, 105585763,
        116144340
    )), row.names = c(NA, -205L), class = c(
        "tbl_df", "tbl",
        "data.frame"
    ))
}

args <- commandArgs(trailingOnly = TRUE)

# `--breaks <file>` writes the table itself, so the golden can carry HiContacts'
# own break positions and widths rather than a transcription of them, and
# `logRoundedBreaks` can be checked against every one.
if (identical(args[1], "--breaks")) {
    write.table(PsBreaks(), args[2], sep = "\t", quote = FALSE, row.names = FALSE)
    quit(save = "no")
}

input <- args[1]
binsize <- as.numeric(args[2])
output <- args[3]

raw <- read.delim(input, stringsAsFactors = FALSE)
out <- lapply(unique(raw$unit), function(unit) {
    sub <- raw[raw$unit == unit, ]
    df <- tibble::tibble(distance = (sub$k - 1) * binsize, n = sub$n) |>
        tidyr::drop_na() |>
        dplyr::mutate(binned_distance = PsBreaks()$break_pos[findInterval(distance, vec = PsBreaks()$break_pos, all.inside = TRUE)])
    df <- dplyr::group_by(df, binned_distance)
    d <- dplyr::summarize(df, ninter = sum(n)) |>
        dplyr::mutate(p = ninter/sum(ninter)) |>
        dplyr::left_join(PsBreaks(), by = c('binned_distance' = 'break_pos')) |>
        dplyr::mutate(norm_p = p / binwidth)
    ps <- dplyr::select(d, binned_distance, ninter, p, norm_p) |>
        dplyr::arrange(binned_distance)
    dplyr::mutate(ps, unit = unit)
}) |> dplyr::bind_rows()

write.table(out, output, sep = "\t", quote = FALSE, row.names = FALSE)
cat(nrow(out), "rows for", length(unique(out$unit)), "curves\n")
