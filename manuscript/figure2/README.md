# Fig. 2 — CTCF's sites in GM12878

`figure2.pdf` (vector, the pile-up and the heatmaps as images) · `figure2.svg` · `figure2.png` (a
300-dpi preview) · `numbers.tsv` (every number the figure draws or quotes).

180 × 100 mm. Type is Helvetica/Arial (Liberation Sans where neither is installed), 4.5–7 pt, panel
letters 8 pt bold.

The data are the paper store's GM12878 files — the card *The Chromosomix paper*, folder
`demo/store/chromosomix_paper/human/`, listed in `demo/store/MANIFEST.tsv` — which its tab *Fig. 2*
opens: 4DN's in situ Hi-C of Rao et al. 2014 (4DNFIXP4QG5B, 4,010,478,943 contacts), ENCODE's CTCF
ChIP-seq of two labs (Bernstein, Broad, ENCSR000AKB; Snyder, Stanford, ENCSR000DZN) and ATAC-seq
(ENCSR095QNB) as fold change over control, the CTCF peaks the app's yapc called on the two ChIP-seq
experiments as replicates (IDR ≤ 0.05), each peak paired with the next along its sequence, and the
map's diamond insulation at four windows. The bacterial figure that was Fig. 2 is now Fig. S3
(`manuscript/figureS3/`).

## What it shows

| panel | what | how |
| --- | --- | --- |
| **a** | APA between consecutive CTCF peaks | The map at 2 kb, ten bins either side of every pair, each window divided by its sequence's expected (`--norm oe`, the app's default; coolpuppy's `ooe`). Pairs on chr1–22 and X, from 22 bins (44 kb, coolpuppy's floor for this window: no window reaches the two diagonals left out) to 1 Mb apart. Rows are the upstream peak, columns the downstream one; RdBu_r centred on 1, symmetric about it over the furthest cell, as the app scales a pile-up over its expected. |
| **b** | CTCF and ATAC-seq at CTCF peaks | The metaplot about every peak's centre, ±2 kb in 50-bp columns, unstranded: the mean of each track with its 95% bootstrap band (200 draws over peaks, the app's default), and under it each track's heatmap, one row a peak, in one order for the three — strongest first by its mean over every column of every track, as the app and `plotHeatmap` sort a run of several tracks. |
| **c** | Insulation at CTCF peaks | The same about the same peaks for the map's diamond insulation at 10 kb with windows of 50, 100, 200 and 400 kb (the store's tracks, computed by the app), ±500 kb in 10-kb columns. |

Every number drawn is the `chromosomix` command's (`apa` and `metaplot`), run by `make_figure.py`
and kept in `build/runs/`. Each heatmap is coloured as the app colours it — viridis from 0 to its
99th percentile, or for the insulation, a signed track, symmetric about 0 over its 1st and 99th —
and drawn as a picture can draw 25,432 rows: each line is the mean of 26 consecutive rows.

## Numbers drawn

| in the figure | value |
| --- | --- |
| CTCF peaks (yapc on both experiments, IDR ≤ 0.05) | 25,432 |
| consecutive pairs; on chr1–22 and X; of those, at most 1 Mb apart | 25,399; 25,394; 25,206 |
| **a**: pairs piled up (44 kb to 1 Mb apart) | 14,121 |
| **a**: P2LL, the centre over the lower-left corner | 1.31 |
| **a**: the centre pixel, observed / expected; the colour scale | 1.88; 0.12 to 1.88 |
| **b**: summit (the column at −50 to 0 bp), mean fold change [95% CI] | CTCF Broad 34.07 [33.77, 34.33]; CTCF Stanford 30.27 [30.06, 30.44]; ATAC-seq 8.38 [8.31, 8.47] |
| **b**: heatmap scales, 0 to | 78.9; 69.5; 22.5 |
| **c**: trough (the column at −10 to 0 kb), mean insulation (log2) [95% CI] | 50 kb −0.074 [−0.077, −0.070]; 100 kb −0.070 [−0.074, −0.065]; 200 kb −0.081 [−0.086, −0.077]; 400 kb −0.124 [−0.129, −0.120] |
| **c**: heatmap scales, ± | 0.71; 0.83; 0.84; 0.92 |

## To check before it goes in

- **The pile-up is at 2 kb, ±10 bins (±20 kb)**, as asked. Pairs nearer than 44 kb are left out, as
  coolpuppy leaves them out at this window by default; 11,085 of the 25,206 consecutive pairs on
  chr1–22 and X within 1 Mb are, and 188 pairs further apart than 1 Mb are not piled up (the band of the map
  read for the expected stops at 1.05 Mb). Say if the pile-up should keep them, or take the near ones
  with a smaller floor.
- **c's rows are in c's own order**: strongest first by the mean insulation over the four windows,
  which is what the app draws for a run of those four tracks — so the top rows are the peaks in the
  most insulated stretches, not the strongest CTCF peaks. The app has no way to borrow b's order for
  c; if the figure should show c in b's order (by CTCF), say so and it is drawn that way here.
- **The peaks are the app's yapc calls** on the two CTCF experiments as replicates (25,432 at
  IDR ≤ 0.05), not ENCODE's own peak sets.
- **Colours** of the three tracks and the insulation are the store's (`GM_COLOURS` in
  `scripts/make_rsg_store.py`), the insulation's four windows shaded from light (50 kb) to dark
  (400 kb).

## Rebuild

```bash
npm ci && npm run build:cli
python -m pip install numpy matplotlib h5py cooler pandas requests
python manuscript/figure2/make_figure.py    # figure2.pdf, figure2.svg, figure2.png, numbers.tsv
```

The first render reads the map's 2-kb rung by range from 4DN's open-data bucket, every contact of
chr1–22 and X within 1.05 Mb of the diagonal (`notebooks/scripts/cool_subset.py`: 6.1 GB read in
9 minutes here, 405 million contacts in a 407-MB .cool written to `build/data/`), and the three ENCODE bigWigs (1.6 GB),
each held to its MD5. The commands' outputs are kept in `build/runs/`, so a second render only draws.
