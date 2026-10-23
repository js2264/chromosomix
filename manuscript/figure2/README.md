# Fig. 2 — CTCF's sites in GM12878, chromosomix beside the reference tools

`figure2.pdf` (vector, the heatmaps as images) · `figure2.svg` · `figure2.png` (a 300-dpi preview) ·
`numbers.tsv` (what each side reports). `chromosomix/` holds the app's own exports, `reference/` the
reference packages' own figures, and the page sets each panel of the one beside the same panel of the
other.

The data are the paper store's GM12878 files — the card *The Chromosomix paper*, tab **Fig. 2** — on
chr19: 4DN's in situ Hi-C of Rao et al. 2014 (4DNFIXP4QG5B, 4.0 billion contacts, 27 GB, read in
place), ENCODE's CTCF ChIP-seq of two labs (Bernstein, Broad, ENCSR000AKB; Snyder, Stanford,
ENCSR000DZN) and ATAC-seq (ENCSR095QNB), each the fold change over control. The bacterial figure that
was Fig. 2 is now Fig. S3 (`manuscript/figureS3/`).

## What it shows

| panel | chromosomix, in the browser | the reference tools |
| --- | --- | --- |
| **a** | *Aggregate peak analysis*: each CTCF peak with the next (*each feature with the next*), the map at 2 kb, ten bins either side, over the expected, from 22 bins (44 kb) apart | coolpuppy 1.1.0: `coolpup.pileup` of a BEDPE of each yapc peak with the next, `flank=20000`, `mindist='auto'` (22 bins), over cooltools' `expected_cis`; drawn by `plotpup.plot` |
| **b** | *Metaplot over a feature set*: both CTCF tracks and ATAC-seq about the peaks' centres, ±2 kb in 50-bp columns — the mean with its 95% bootstrap band, and a heatmap a track, the peaks strongest first over the three | deepTools 4.0.0: `computeMatrix reference-point --referencePoint center`, `-b/-a 2000 --binSize 50`; `plotProfile --perGroup --plotType se` (the mean and its standard error: deepTools has no bootstrap) and `plotHeatmap`, sorted by its default, the mean over every sample, descending, its heatmaps alone |
| **c** | the same over the four insulation tracks, ±500 kb in 10-kb columns | the same over cooltools' insulation at the four windows, `-b/-a 500000 --binSize 10000` |

Upstream of those, each side runs its own chain on chr19: insulation at 50, 100, 200 and 400 kb on
the 10-kb map (the app's *Diamond insulation*; `cooltools.insulation`), and the CTCF peaks on the two
labs' tracks as replicates at IDR ≤ 0.05 (the app's *Peak calling*; yapc 0.1 with IDR 2.0.3, seed 0),
both at the validation notebook's settings. Every link is held to its reference there, number for
number (`notebooks/validation.qmd`, § 24); this page is the same comparison as pictures.

Each side draws its own figure. What is set alike is only what lets two pictures be read side by
side: the colour maps and their ranges, by the app's rules (RdBu_r symmetric about 1 for the pile-up;
viridis from 0 to the 99th percentile for a heatmap, symmetric about 0 for a signed one), and the
curves' colours, the app's palette in the app's order.

## In the browser, end to end

Open the lab store's card *The Chromosomix paper*, tab **Fig. 2**: the map on chr19 at 10 kb with the
two CTCF tracks and ATAC-seq, nothing computed. Show the Analysis column; each task opens on the
figure's recipe.

1. **Diamond insulation** → Run. Four insulation tracks, their boundaries and domains.
2. **Peak calling** → Run. *Peaks · CTCF · Broad + CTCF · Stanford · IDR ≤ 0.05*, 2,101 peaks.
3. Switch the map to **2 kb**. **Aggregate peak analysis**, features: the peaks → Run. Save the
   pile-up with its **PDF** button (panel a).
4. **Metaplot over a feature set**, features: the peaks → Run. Save the profile and the three
   heatmaps (panel b).
5. Tick the four insulation tracks instead, flank **500000**, resolution **10000** → Run. Save the
   profile and the four heatmaps (panel c).

About five minutes from a laptop, most of it the 2-kb map read for the expected.
`chromosomix_panels.mjs` does exactly this in headless Chromium and writes `chromosomix/`.

## To check before it goes in

- **The two sides' bands are different statistics**: the app's is a 95% percentile bootstrap over
  peaks, deepTools' the standard error of the mean. The means are the same numbers (§ 24).
- **plotHeatmap's heatmaps are drawn without the profile it puts over them by default**
  (`--whatToShow 'heatmap and colorbar'`), since `plotProfile`'s is the panel above them, as the app
  draws its profile apart from its heatmaps. deepTools' labels are one word each (`CTCF-Broad`): it
  breaks a label at its spaces and reads its matrix's header as ASCII.
- **The pile-up is at 2 kb, ±10 bins**, as asked for the genome-wide version; on chr19 it piles 327
  of the 2,100 pairs (those at least 44 kb apart). Say if it should be at 5 or 10 kb, where more
  pairs clear the floor.

## Rebuild

```bash
npm ci && npm run build:cli
python3 scripts/make_rsg_store.py stage --out gallery/stage --local http://127.0.0.1:5173
npm run dev -- --host 127.0.0.1 --port 5173 &
node manuscript/figure2/chromosomix_panels.mjs                                  # chromosomix/
YAPC_PYTHON=yapc-env/bin/python refs/bin/python manuscript/figure2/reference.py  # reference/
refs/bin/python manuscript/figure2/make_figure.py                                # figure2.*
```

The environments are the validation notebook's (`refs` and yapc's, *To render* there).
`reference.py` reads chr19 of the map's 10-kb and 2-kb rungs by range from 4DN's bucket
(`notebooks/scripts/cool_subset.py`, 0.3 GB) and ENCODE's three bigWigs (1.6 GB, each held to its
MD5) into `build/`, and keeps the tools' working files there; yapc takes about five minutes.
