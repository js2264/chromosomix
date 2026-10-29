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
   domains**, mode **scaled**, grid **51**, flank **0.5**, normalisation **distance-matched** (the app
   refuses observed / expected on a scaled grid), five controls a domain, shifted by **1** to **3** windows, seed
   **1** → Run: the 305 TADs, in / out 1.23 (panel **d**). Set it back to step 3's settings before
   running panel a again.

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
| **d** | `d-tads.pdf` | coolpuppy 1.1.0: `coolpup.pileup` of the 305 domains between consecutive boundaries of cooltools' 50-kb window, `local=True`, `rescale=True`, `rescale_flank=0.5`, `rescale_size=51`, over `nshifts=5` controls at its default shifts (100 kb to 1 Mb); `plotpup.plot` |

Upstream, the peaks are yapc 0.1's with IDR 2.0.3 (seed 0) and the insulation `cooltools.insulation`'s,
at the validation notebook's settings, where every link but d is held to the app number for number
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
| **a** APA, max \|Δ\| over every cell | 0.014 observed / expected (0.015 in log2): one peak's centre, half a base before a bin edge (below); put in the app's bin, coolpuppy's cells are the app's to 5.0e-6 |
| **b** mean profiles, max \|Δ\| | 4.5e-5 CTCF · Broad, 2.8e-5 CTCF · UW, 4.8e-6 ATAC (fold change) |
| **c** mean profiles, max \|Δ\| | 5.6e-8, 6.1e-8, 4.9e-7 and 4.9e-7 at 400, 200, 100 and 50 kb (log2) |
| **d** TADs, max \|Δ\| over the cells both fill | 0.099 observed / expected (0.132 in log2): *The TAD pile-up is alike, not equal*, below |

What is set alike on the two sides is only what lets them be read together: the colour maps and their
ranges by the app's rules, and the curves' colours, the app's palette in the order of its tracks.

## To check before it goes in

- **The two bands are different statistics**: the app's is a 95% percentile bootstrap over the peaks,
  deepTools' the standard error of the mean. The means are the same numbers (§ 24).
- **deepTools' labels are one word each** (`CTCF-Broad`, `400kb`): it breaks a label at its spaces and
  reads its matrix's header as ASCII.
- **The pile-up is at 2 kb, ±10 bins**: on chr19 it piles 327 of the 2,105 consecutive pairs, those at
  least 44 kb apart. Say if it should be at 5 or 10 kb, where more pairs clear the floor.
- **Panel a's cells are coolpuppy's to 1%, not to six digits**: one peak, chr19:29,467,891-29,468,109,
  has its centre half a base before a 2-kb bin edge, and the app rounds it into the next bin where
  coolpuppy floors it. Centre (1.420) and P2LL (1.168 against 1.169) are unmoved; § 24, at 10 kb, has
  no such peak.
- **The TAD pile-up is alike, not equal**: § 24 does not hold it. coolpuppy stretches each window evenly
  onto the grid where the app pins every domain's two ends to the same grid lines, shifts its controls
  by 100 kb to 1 Mb where the app shifts by one to three windows, and blanks the cells the first two
  diagonals reach once resampled. On the same 305 domains the app's in / out is 1.234 and coolpuppy's,
  by the app's formula, 1.236; the two pileups correlate at 0.994 off those two diagonals, and no cell
  differs by more than 0.10. coolpuppy's shifts barely move it: 1.232 to 1.237 from 100 kb–1 Mb to
  500 kb–1.5 Mb.
- **The app's ticks on d read −0.01 and 1.01** where the domain starts and ends: it spaces five ticks
  evenly, and they land on the domain's two ends only on a grid that is a multiple of four, where
  coolpuppy wants an odd one. 51 is kept on both sides.

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
