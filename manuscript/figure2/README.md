# Fig. 2 — CTCF's sites in GM12878, by chromosomix and by the reference tools

Two sets of panels, made separately and set side by side by hand: chromosomix's, made in the app from
the lab store's Fig. 2 tab; and the reference tools', made by `reference.qmd` into `reference/`, one
file a panel (PDF, and a PNG to look at).

The data are the paper store's GM12878 files on chr19: 4DN's in situ Hi-C of Rao et al. 2014
(4DNFIXP4QG5B, 4.0 billion contacts, 27 GB, read in place), ENCODE's CTCF ChIP-seq of two labs
(Bernstein, Broad, ENCSR000AKB; Stamatoyannopoulos, UW, ENCSR000DRZ) and ATAC-seq (ENCSR095QNB), each the
fold change over control. The bacterial figure that was Fig. 2 is now Fig. S3 (`manuscript/figureS3/`).

## chromosomix, in the browser

Open the lab store's card *The Chromosomix paper*, tab **Fig. 2**: the map on chr19 at 10 kb with the
two CTCF tracks and ATAC-seq, nothing computed. Show the Analysis column; each task opens on the
figure's settings.

1. **Diamond insulation** → Run: insulation at 50, 100, 200 and 400 kb, their boundaries and domains.
2. **Peak calling** → Run: *Peaks · CTCF · Broad + CTCF · UW · IDR ≤ 0.05*, 2,106 peaks.
3. Switch the map to **2 kb**. **Aggregate peak analysis**, anchors **consecutive features**, features
   the peaks → Run: each peak with the next, ten bins either side, over the expected, from 22 bins
   apart (panel **a**).
4. **Metaplot over a feature set**, features the peaks, tracks both CTCF and ATAC → Run: the profile
   with its band, and a heatmap a track (panel **b**).
5. The same with the four insulation tracks instead, flank **500000**, resolution **10000** → Run
   (panel **c**).

Each figure is saved by its own **PDF** button. About five minutes, most of it the 2-kb map read for
the expected.

## The reference tools

`reference.qmd` runs the same chain on the same chr19, each link by the package the app's task
reproduces, every panel drawn by that package's own plotting:

| panel | file | how |
| --- | --- | --- |
| **a** | `a-apa.pdf` | coolpuppy 1.1.0: `coolpup.pileup` of each yapc peak with the next, `flank=20000`, `mindist='auto'` (22 bins), over cooltools' `expected_cis`; `plotpup.plot` |
| **b** | `b-profile.pdf`, `b-heatmaps.pdf`, `b-heatmap-<track>.pdf` | deepTools 4.0.0: `computeMatrix reference-point --referencePoint center`, ±2 kb in 50 bp; `plotProfile --perGroup --plotType se`; `plotHeatmap`, the three together and each on its own in one order |
| **c** | `c-profile.pdf`, `c-heatmaps.pdf`, `c-heatmap-<window>.pdf` | the same over cooltools' insulation at the four windows, ±500 kb in 10 kb |

Upstream, the peaks are yapc 0.1's with IDR 2.0.3 (seed 0) and the insulation `cooltools.insulation`'s,
at the validation notebook's settings, where every link is held to the app number for number
(`notebooks/validation.qmd`, § 24). `reference/numbers.tsv` lists what each panel was made from and
draws.

What is set alike on the two sides is only what lets them be read together: the colour maps and their
ranges by the app's rules, and the curves' colours, the app's palette in the order of its tracks.

## To check before it goes in

- **The two bands are different statistics**: the app's is a 95% percentile bootstrap over the peaks,
  deepTools' the standard error of the mean. The means are the same numbers (§ 24).
- **deepTools' labels are one word each** (`CTCF-Broad`, `400kb`): it breaks a label at its spaces and
  reads its matrix's header as ASCII.
- **The pile-up is at 2 kb, ±10 bins**: on chr19 it piles 327 of the 2,105 consecutive pairs, those at
  least 44 kb apart. Say if it should be at 5 or 10 kb, where more pairs clear the floor.

## Rebuild

```bash
QUARTO_PYTHON=refs/bin/python YAPC_PYTHON=yapc-env/bin/python quarto render manuscript/figure2/reference.qmd
```

The environments are the validation notebook's (`refs`, with Quarto as the `quarto-cli` package, and
yapc's own; *To render* in `notebooks/validation.qmd`). The first render reads chr19 of the map's 10-kb
and 2-kb rungs by range from 4DN's bucket (0.3 GB) and ENCODE's three bigWigs (1.6 GB, each held to its
MD5) into `build/`, and keeps the tools' working files there; yapc takes about five minutes.
