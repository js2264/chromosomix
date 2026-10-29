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
   the peaks (*Peaks · CTCF · Broad + CTCF · UW · IDR ≤ 0.05*, not the insulation's boundaries, which
   the list also holds once step 1 has run), normalisation **observed / expected** → Run: each peak
   with the next, ten bins either side, from 22 bins apart, 327 pairs, P2LL 1.17 (panel **a**).
4. **Metaplot over a feature set**, features the peaks, tracks both CTCF and ATAC → Run: the profile
   with its band, and a heatmap a track (panel **b**).
5. The same with the four insulation tracks instead, flank **500000**, resolution **10000** → Run
   (panel **c**).
6. Still at 2 kb, **Aggregate peak analysis** again: anchors **feature set**, features **Insulation
   domains**, mode **scaled**, grid **51**, flank **0.5**, normalisation **observed / expected** → Run:
   the 305 TADs, each stretched evenly over the expected, in / out 1.22 (panel **d**). Set it back to
   step 3's settings before running panel a again.

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
| **d** | `d-tads.pdf` | coolpuppy 1.1.0: `coolpup.pileup` of the 305 domains between consecutive boundaries of cooltools' 50-kb window, `local=True`, `rescale=True`, `rescale_flank=0.5`, `rescale_size=51`, over panel a's `expected_cis` (`ooe`); `plotpup.plot` |

Upstream, the peaks are yapc 0.1's with IDR 2.0.3 (seed 0) and the insulation `cooltools.insulation`'s,
at the validation notebook's settings, where every link is held to the app number for number
(`notebooks/validation.qmd`, § 24). `reference/numbers.tsv` lists what each panel was made from and
draws.

`reference/agreement.tsv` sets the two sides against each other. chromosomix's side is made again by its
command line on the same chr19, at the tab's recipes, and each side keeps its own chain, as the figure
does:

| what | chromosomix against the reference |
| --- | --- |
| peaks at IDR ≤ 0.05, Jaccard (bases in both over bases in either) | 1.0000, the same 2,106 |
| boundaries at 50 kb, Jaccard | 1.0000, the same 306 |
| insulation, max \|Δ\| over every bin (log2) | 4.7e-6 at 50 kb; 5.0e-6 at most over the four windows |
| **a** APA, max \|Δ\| over every cell | 5.0e-6 observed / expected (6.6e-6 in log2) |
| **b** mean profiles, max \|Δ\| | 4.5e-5 CTCF · Broad, 2.8e-5 CTCF · UW, 4.8e-6 ATAC (fold change) |
| **c** mean profiles, max \|Δ\| | 5.6e-8, 6.1e-8, 4.9e-7 and 4.9e-7 at 400, 200, 100 and 50 kb (log2) |
| **d** TADs, max \|Δ\| over the cells both fill | 5.0e-6 observed / expected (7.1e-6 in log2); the same 151 cells blank |

What is set alike on the two sides is only what lets them be read together: the colour maps and their
ranges by the app's rules, and the curves' colours, the app's palette in the order of its tracks.

## To check before it goes in

- **The two bands are different statistics**: the app's is a 95% percentile bootstrap over the peaks,
  deepTools' the standard error of the mean. The means are the same numbers (§ 24).
- **deepTools' labels are one word each** (`CTCF-Broad`, `400kb`): it breaks a label at its spaces and
  reads its matrix's header as ASCII.
- **The pile-up is at 2 kb, ±10 bins**: on chr19 it piles 327 of the 2,105 consecutive pairs, those at
  least 44 kb apart. Say if it should be at 5 or 10 kb, where more pairs clear the floor.
- **Panel a's cells are coolpuppy's to six digits** since the app rounds a peak's midpoint down, as
  coolpuppy does. One peak, chr19:29,467,891-29,468,109, has its centre half a base before a 2-kb bin
  edge; rounded to the nearest base it went into the next bin, and the cells it fed were up to 1.4 %
  off coolpuppy's. § 24 holds this panel at 2 kb.
- **The TAD pile-up is over the expected, not over controls**, which is what lets it be coolpuppy's
  cell for cell: nothing is drawn at random, and over the expected the app cuts and resamples a
  domain's window as coolpuppy does — scaled about its middle, stretched evenly, every grid cell a
  dropped bin or the first two diagonals reach left blank. In / out is 1.218 on both sides. Over
  distance-matched controls, as it was drawn before, the two were alike and not equal (in / out 1.234
  against 1.236, up to 0.13 apart in log2): the app pins every domain's two ends to the same grid lines
  there, averages round a dropped bin, and draws its own random shifts.
- **The ticks on d read −0.5, 0, 0.5, 1 and 1.5**: stretched evenly, the window is one straight line from
  half a domain before it to half a domain after, so its two ends are the second and fourth ticks.

## Rebuild

```bash
npm run build:cli
```

```bash
QUARTO_PYTHON=refs/bin/python YAPC_PYTHON=yapc-env/bin/python quarto render manuscript/figure2/reference.qmd
```

The environments are the validation notebook's (`refs`, with Quarto as the `quarto-cli` package, and
yapc's own; *To render* in `notebooks/validation.qmd`). The first render reads chr19 of the map's 10-kb
and 2-kb rungs by range from 4DN's bucket (0.3 GB) and ENCODE's three bigWigs (1.6 GB, each held to its
MD5) into `build/`, and keeps the tools' working files there; yapc takes about five minutes.
