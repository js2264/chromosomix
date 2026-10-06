# Fig. 1 — a proposal

`figure1.pdf` (vector, fonts embedded, heatmaps as images) · `figure1.svg` (the editable master) ·
`figure1.png` (a 300-dpi preview).

180 × 170 mm: Nature's double-column width and its maximum height, which leaves the legend room
under the figure. Type is Helvetica/Arial (Liberation Sans, Arial's metrics, where neither is
installed — it is what the PDF embeds), 5–7 pt, panel letters 8 pt bold. Every element is vector
except the contact maps, the pile-up, the model-versus-map square and the UI screenshot, which are
images at 820–1,900 ppi with interpolation off.

The data are mouse, to show the app at the scale of a mammalian genome: in situ Hi-C of F123
mouse embryonic stem cells from the 4DN Data Portal (4DNFI5QJNFAT: one 7.0-GB .mcool, 1.07
billion contacts, 13 resolutions from 1 kb to 10 Mb) with ChIP-seq of CTCF, H3K27ac and H3K4me3,
read in place in the session and browsed from the 2.6-Gb genome down to single bases.

## What it shows

| panel | idea | how |
| --- | --- | --- |
| **a** | The app itself | The real window, on the 4DN map and tracks read in place from 4DN's open-data bucket, at the *Sox2* locus (chr3:34.2–35.2 Mb, 5 kb). Diamond insulation and *Model from the map* run from the Analysis column; a deck of the map, the model (coloured by H3K27ac) and a 1D browser. Five numbered points name what the paper claims of the session. |
| **b** | The whole spectrum of data | What is read and what is computed, by dimension, from Supplementary Tables 2 and 3. Colours are the figure's dimension code: 1D blue, 2D vermillion, 3D purple. |
| **c** | One coordinate system, every scale | One session from the whole genome (2.6 Gb) through chromosome 3, a 10-Mb region, the 1-Mb *Sox2* locus and 200 kb around the gene, to 500 bp at *Sox2*'s start codon. Rows are dimensions, columns are scales; each column zooms into the window marked in the one before (shaded on the tracks, outlined on the map, coloured on the model). Each scale has its own 3D model, inferred from the map at that scale's resolution; the model stops at its 5-kb beads, the map at its 1-kb bins, the tracks go on to the sequence and its reading frame — the staircase is the point. |
| **d** | Seeing and measuring, back and forth | SEE columns hold what is drawn in the view, MEASURE columns the tasks that read it. From one map, two chains cross every pair of dimensions in both directions: 2D→1D (insulation), 1D→1D (metaplot, ranked), 1D→2D (domain pile-up), 2D→3D (pastis-NB), 1D→3D (colour by a track), 3D→2D (model versus map), 3D→1D (spatial tracks). Each task shows its command; the dashed loop says every result is in the session for the next one. |

Panels **c** and **d** are the legend's two sentences ("one session browsed … at native
resolution" and "the analysis chains across dimensions …"), and draw nothing that the app did not
compute: every track, set, pile-up and model is an output of `metacooler-run`
(`run_analyses.sh`), and the four models of panel **c** (and panel **d**'s) are inferred from the
map, each at its column's resolution.

## Proposed legend

**Fig. 1 | Chromlens integrates browsing and quantitative analysis of 1D, 2D and 3D chromatin data
in a web browser.** **a**, A Chromlens session in a browser tab, on in situ Hi-C of mouse
embryonic stem cells (1.07 billion contacts) with ChIP-seq of CTCF, H3K27ac and H3K4me3, at the
*Sox2* locus: files are read in place from the 4DN Data Portal and never uploaded (1); only the
region and resolution in view are read, here 47 MB of a 7-GB file (2); a deck shows the contact
map with its tracks, a 3D model inferred in the session and a 1D browser on one coordinate system,
panned and zoomed together (3); analyses run in a background worker and their outputs join the
session (4); each step is logged as its command-line equivalent (5). **b**, File formats read and
analyses run, by dimension (Supplementary Tables 2 and 3). **c**, One session browsed from the
whole genome to single bases. Each column zooms into the window marked in the previous one (shaded
on the tracks, outlined on the map, coloured on the model). The 3D model of each scale is inferred
from the map at that scale's resolution (pastis-NB; 2.5 Mb, 250 kb, 25 kb and 5 kb); the model,
the contact map and the linear tracks follow the view down to the finest unit each holds: 5-kb
beads, 1-kb bins and single bases. Genome, the map scaled on its contacts between chromosomes, and
chromosome 3 highlighted; chromosome 3, its first eigenvector at 250 kb, signed by H3K27ac (A, red;
B, blue); region and locus, models coloured by H3K27ac; locus, circles, loops called with
Chromosight; gene, the 1-kb map averaged over 3 × 3 bins, with the *Sox2* promoter and the *Sox2*
control region (SCR) marked (triangles) and where they meet on the map (dashed circle); base pairs,
*Sox2*'s start codon and first five codons. **d**, Visualization and analysis alternate, and
analyses chain across dimensions. Borders detected on the map by diamond insulation (10-kb bins,
100-kb window; 7,743 borders and 7,723 domains over the autosomes and X) become a track and a
feature set; CTCF ChIP-seq is piled up at the borders, ranked into quarters by border strength
(fold enrichment within 1 kb of the border over the flanks beyond 80 kb), and the domains the
borders delimit are rescaled and piled up on the map against matched controls
(observed/expected). A 3D model inferred from the map (pastis-NB, chromosome 3, 624 beads of
250 kb) is coloured by the H3K27ac track, compared back to the map (Spearman ρ between contacts
and inverse model distances) and turned into a radial-position track. Commands are abbreviated;
the full ones are in the console and in the Methods.

## Main text: where the panels are cited

The current draft cites Fig. 1a (browsing) and Fig. 1b (analysis). With four panels:

- "…quantitative analysis across 1D, 2D and 3D data is part of browsing itself (**Fig. 1a**,
  Supplementary Table 1)."
- "It supports most contact map formats …, linear tracks … and 3D models (**Fig. 1b**;
  Supplementary Table 2)."
- "Contact maps can be browsed from compartments spanning a whole genome to the finest bins the
  file holds, with linear tracks and the 3D model following the region in view and several panels
  side by side (**Fig. 1a,c**)."
- "…data can be analysed directly in the browser, where they are displayed (**Fig. 1b,d** and
  Supplementary Table 3)."
- "…so analyses chain across dimensions (**Fig. 1d**). For example, borders detected on a map …"

## Numbers drawn, and where they come from

| in the figure | value | file |
| --- | --- | --- |
| borders, domains | 7,743, 7,723 (chr1–19 and X, 10-kb bins, 100-kb window) | `results/insulation/*.bed` |
| CTCF at the borders, by quarter of border strength | 1.85×, 1.61×, 1.45×, 1.30× (±1 kb over \|d\| > 80 kb) | `results/metaplot/*metaplot.tsv` |
| domains piled up | 7,723, drawn on 0.7–1.4 observed/expected | `results/domains/*apa-0.tsv` |
| compartments, chromosome 3 | E1 at 250 kb, r = 0.715 with H3K27ac | `results/compartments/*components.tsv` |
| loops | 918 on chromosome 3, 6 in chr3:34.2–35.2 Mb | `results/loops/*.bedpe` |
| models (beads of the map's bins) | genome 1,014 of 1,063 (2.5 Mb); chr3 624 of 641 (250 kb); region 400 of 400 (25 kb); locus 199 of 200 (5 kb) | `results/model-*/*fit.tsv` |
| ρ(contacts, 1/distance) | 0.94 on chromosome 3 (0.85 for the region, 0.72 for the locus, 0.53 genome-wide with the trans pairs) | `results/model-vs-map/*agreement.tsv`, `results/model-*/*fit.tsv` |
| read for the view in **a** | 47.2 MB of the 7.03-GB .mcool | the browser's network log while `capture-ui.mjs` ran |

The whole chain ran in 3 min 14 s here on four 2.8-GHz cores, insulation over the genome at 10 kb
in 47 s; in panel **a**, *Model from the map* took 3.7 s in the browser.

## To check before it goes in

- **The name.** The build still says (meta)cooler. `capture-ui.mjs` rewrites the header's word,
  and `metacooler-run`, to Chromlens in the page before the shot; nothing else on screen is
  edited. Re-shoot once the app carries the name, or set `BRAND` if the name changes again.
- **Data provenance.** Hi-C: Kubo et al., *Nat. Struct. Mol. Biol.* 2021 (PMID 33398174), 4DN
  file 4DNFI5QJNFAT. ChIP-seq: Huang et al. 2021 (PMID 34002095), 4DN files 4DNFIFFXFV82 (CTCF),
  4DNFIXE23VC7 (H3K27ac) and 4DNFIQYJLKKH (H3K4me3). Genes and sequence: mm10, from Illumina's
  iGenomes (UCSC). The legend and the Data availability statement need these; check the cell
  line and the papers against the 4DN experiment sets before submission.
- **The SCR.** Panel **c** marks the *Sox2* control region at chr3:34,760,000 (mm10), about
  110 kb downstream of *Sox2*; check the coordinate against the paper you cite for it.
- **Two maps are not on the app's default scale.** The genome map in **c** is clipped on its
  contacts between chromosomes (5th–99.9th percentile of their log values), the way a reader sets
  a whole-genome view, so that the chromosomes saturate and the plaid between them shows; every
  other map uses the app's auto range (1st–99th percentile). The 1-kb map of the Gene column is
  shown with the app's 3 × 3 averaging; unaveraged, 200 kb at 1 kb is mostly empty pixels.
- **Fonts.** The SVG names Helvetica and Arial; this PDF was built on a machine with neither and
  embeds Liberation Sans, which has Arial's metrics. Re-run `svg2pdf.mjs` on a machine with Arial,
  or open the SVG in Illustrator, to embed Arial itself.
- **Panel a's model** is the one *Model from the map* inferred in the session, for the region in
  view; panel **c**'s locus model is `run_analyses.sh`'s for the same window and resolution, and
  panel **d**'s is chromosome 3 at 250 kb. All are pastis-NB on the same map.
- **The yeast version.** The first proposal drew the same four panels on the yeast micro-C demo;
  it is in commit 6f20b0b.

## Rebuild

```bash
npm ci && npm run build:cli
python -m pip install cooler pyBigWig numpy pillow

bash manuscript/figure1/run_analyses.sh          # results/: fetches ~8.9 GB once, then ~3 min of the app's command line
npm run dev -- --host 127.0.0.1 --port 5173 &
node manuscript/figure1/capture-ui.mjs           # ui-session.png: the real app, headless, reading from 4DN
python manuscript/figure1/make_figure.py         # figure1.svg
node manuscript/figure1/svg2pdf.mjs              # figure1.pdf and figure1.png
```

`make_figure.py` reads the inputs in `build/mouse/` (written by `run_analyses.sh`), `results/`
and `ui-session.png`, and the 500 bp of mm10 it spells out by byte range from iGenomes' FASTA
(cached in `build/mouse/` after the first read). `capture-ui.mjs` opens
`session/mouse_sox2.metacooler.json`, which reads the map and the ChIP-seq from 4DN's bucket and
the genes from `build/mouse/genes_chr3.gtf`. Each panel is one function, laid out in millimetres,
so a panel can be moved, dropped or resized without touching the others.
