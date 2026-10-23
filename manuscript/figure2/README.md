# Fig. 2 — bacterial chromosomes along their arms

`figure2.pdf` (vector, the maps as images) · `figure2.svg` · `figure2.png` (a 300-dpi preview) ·
`numbers.tsv` (every number the figure draws or quotes).

180 × 262 mm, the layout of the draft the panels were planned on: a full page, the legend on the
facing one. Type is Helvetica/Arial (Liberation Sans where neither is installed), 4–8 pt.

The data are the paper store's — the card *The Chromosomix paper*, folder
`demo/store/chromosomix_paper/`, listed in `demo/store/MANIFEST.tsv` — so a reader who opens the
store's tabs S3a, S3b and S3c sees these maps in the app. The store files these panels as Fig. S3:
its Fig. 2 is now GM12878's CTCF sites (`scripts/make_rsg_store.py`, `paper_fig2`).

## What it shows

| panel | what | how |
| --- | --- | --- |
| **a** | *C. necator* N-1, chromosome 1 at 8 kb, origin in the middle, read six ways | Top: balanced contacts; observed/expected over the distance decay, where the X of the aligned arms remains; the correlation of that. Bottom: the decay along both arms itself; observed/expected over it, both diagonals divided out; the correlation of that. Beside them, the inter-arm task's profile of the secondary diagonal before and after detrending, and its three decays (along the diagonal, within an arm, across the arms). |
| **b** | The *B. subtilis* PY79 ParB time course at 10 kb | WT, ΔparAB and 0–45 min after ParB is induced, on the wild type's colour scale. Beside them, how far from the origin the arms are aligned (the inter-arm task's reach) against minutes, with the least-squares line over 15–45 min, and the wild type's and ΔparAB's reach as references. |
| **c** | *P. aeruginosa* WT (MM38), SMC-ScpAB– (FG0235) and MksBEF– (FG0238) at 8 kb | Balanced contacts; the correlation of observed/expected over the distance decay; the same over the decay along both arms; E1 along both arms. |
| **d** | The wild type's compartments (E1 along both arms, A and B) | GC content per 8-kb bin, gene expression (RNA-seq of PAK at T0, GEO GSE76513, the mean CPM of each 8-kb bin, drawn on log10) and radial distance from the model's barycentre, A against B, each with the Mann–Whitney P of the app's *Signal by group*; the 3D model (pastis-NB) on its first two principal axes, coloured A and B. |

Everything computed is the `chromosomix` command's: the origins (*Origin and terminus*, each
chromosome read as a circle), the inter-arm alignment and its decays, E1 and the A/B segments,
the base composition, the 3D model and its radial positions, and the tests. The maps are drawn from
the .mcool with the app's arithmetic, ported line for line as
`notebooks/dbz-chromosome-figures.qmd` ports it and checks it against the CLI. Every map is coloured
with the app's ramps and its automatic range (1st–99th percentile of the cells with contacts; for a
ratio or a correlation, the 99th percentile of the distance from neutral), and keyed as the app
keys it.

## Numbers drawn

| in the figure | value |
| --- | --- |
| *C. necator*: origin; secondary-diagonal enrichment; after detrending; arms aligned over | 8,501; 4.37×; 0.93×; 1.83 of 1.94 Mb |
| *B. subtilis*: reach, WT and ΔparAB | 2.02 and 0.93 Mb |
| *B. subtilis*: reach, 0, 15, 20, 30, 35, 45 min after ParB is induced | 1.11, 0.93, 1.00, 1.30, 1.58, 1.91 Mb |
| *B. subtilis*: least squares over 15–45 min | 33.9 kb/min, r² = 0.981 (the same fit the app draws, `scripts/ui-interarm.mjs`, ia9) |
| *P. aeruginosa*: origin | 6,250,501 |
| WT compartments: bins A / B | 550 / 232 |
| GC content, A against B | 67.0% against 65.5%, P = 2.2 × 10⁻²⁰ |
| radial distance, A against B | 0.86 against 1.15, P = 5.8 × 10⁻³⁴ |
| gene expression, A against B (median CPM per 8-kb bin) | 0.69 against 3.91, P = 4.1 × 10⁻⁵⁵ |

## To check before it goes in

- **Panel d's P values differ from the draft's** (3.98 × 10⁻²⁸ for GC, 2.21 × 10⁻¹¹³ for the radial
  distance), though the distributions look the same. These are 8-kb bins of the WT map, E1 along
  both arms by the app's default method; say which sample, bin size or method the draft's came
  from, and the script follows it.
- **A is the GC-rich side.** E1 is signed by GC content, as the app signs it, so A is where E1
  rises with GC. Here B is the more expressed and the more peripheral side, as the draft drew it.
- **The RNA-seq is PAK at T0 (GEO GSE76513)**, on the maps' PAO1_v3 reference; say if the
  draft's came from another strain or condition.
- **The boxes beside a and b were empty in the draft.** They now hold what the inter-arm task
  draws for exactly this (§18.8): the profile before and after detrending with its three decays,
  and the reach against minutes. Drop them if something else was meant.
- **Labels**: ΔparAB, as the store names it, where the draft wrote parAB–.
- **Data provenance** of the three bacterial datasets is not in the store's card yet.

## Rebuild

```bash
npm ci && npm run build:cli
python -m pip install numpy scipy matplotlib h5py
python manuscript/figure2/make_figure.py    # figure2.pdf, figure2.svg, figure2.png, numbers.tsv
```

The inputs (about 380 MB) are read once into `build/data/`, from the store's folder on the lab's
bucket or, where a file is not published there, from the source the manifest names; the commands'
outputs are kept in `build/runs/`, so a second render only draws (about 20 s here from scratch).
