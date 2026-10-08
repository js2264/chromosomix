# Fig. 1 — a proposal

`figure1.pdf` (vector, fonts embedded, heatmaps as images) · `figure1.svg` (the editable master) ·
`figure1.png` (a 300-dpi preview).

180 × 170 mm: Nature's double-column width and its maximum height, which leaves the legend room
under the figure. Type is Helvetica/Arial (Liberation Sans, Arial's metrics, where neither is
installed — it is what the PDF embeds), 5–8 pt, panel letters 8 pt bold. Every element is vector
except the contact maps, the pile-up, the model-versus-map square and the UI screenshot, which are
images: the maps at 570–2,400 ppi with interpolation off, the screenshot at 700 ppi, smoothed.

The data are mouse, to show the app at the scale of a mammalian genome: in situ Hi-C of F123
mouse embryonic stem cells from the 4DN Data Portal (4DNFI5QJNFAT: one 7.0-GB .mcool, 1.07
billion contacts, 13 resolutions from 1 kb to 10 Mb) with ChIP-seq of CTCF, H3K27ac and H3K4me3,
read in place in the session and browsed from the 2.6-Gb genome down to single bases.

## What it shows

| panel | idea | how |
| --- | --- | --- |
| **a** | The app itself | The real window, on the 4DN map and tracks read in place from 4DN's open-data bucket, at the *Sox2* locus (chr3:34.2–35.2 Mb, 5 kb). Diamond insulation and *Model from the map* run from the Analysis column; a deck of the map, the model (coloured by H3K27ac) and a 1D browser. Five numbered points name what the paper claims of the session. |
| **b** | The whole spectrum of data | Per dimension, how many file types it reads and how many analyses it runs (Supplementary Tables 2 and 3), some of its formats and a few of its analyses, stacked in the order of panel **c**'s rows. Colours are the figure's dimension code: 3D purple, 2D vermillion, 1D blue. |
| **c** | One coordinate system, every scale | One session from the whole genome (2.6 Gb) through chromosome 3, a 10-Mb region, the 1-Mb *Sox2* locus and the 250 kb holding *Sox2* and its control region, to the 1 kb at *Sox2*'s start codon. Rows are dimensions, columns are scales; each column zooms into the window marked in the one before (shaded on the tracks, outlined on the map, drawn dark along the grey model). Each scale has its own 3D model, inferred from the map at that scale's resolution (2.5 Mb, 250 kb, 10 kb, 5 kb, 2 kb); at the gene it is coloured by H3K27ac and by H3K4me3. The last column has no model and no map — a bead and a bin are 2 kb there — and the tracks go on to the sequence and its reading frame: the staircase is the point. |
| **d** | Seeing and measuring, back and forth | SEE columns hold what is drawn in the view, MEASURE columns the tasks that read it. From one map at 10 kb, two chains: diamond insulation (2D→1D) gives borders and domains, which a metaplot of CTCF (1D→1D, ranked by border strength) and a domain pile-up on the map (1D→2D) read in turn; a model inferred from the map (2D→3D) is drawn coloured by CTCF and compared back to the map (3D→2D). Each task shows the command that reruns it and the second input it reads from the view, if any. |

Panels **c** and **d** are the legend's two sentences ("one session browsed … at native
resolution" and "the analysis chains across dimensions …"), and draw nothing that the app did not
compute: every track, set, pile-up and model is an output of `metacooler-run`
(`run_analyses.sh`), and the five models of panel **c** (and panel **d**'s) are inferred from the
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
on the tracks, outlined on the map, drawn dark along the model). The 3D model of each scale is
inferred from the map at that scale's resolution (pastis-NB; 2.5 Mb, 250 kb, 10 kb, 5 kb and
2 kb); the model, the contact map and the linear tracks follow the view down to the finest unit
each holds: 2-kb beads, 2-kb bins and single bases. Genome, the map scaled on its contacts between
chromosomes, and each chromosome's contacts; chromosome 3, the correlation between the rows of its
observed/expected map at 250 kb and its first eigenvector, signed by H3K27ac (A, red; B, blue);
chr3:27–37 Mb, the map at 10 kb with its insulation score and borders; chr3:34–35 Mb,
observed/expected at 5 kb with loops called by Chromosight (circles), genes and CTCF; chr3:34.55–
34.80 Mb, the map at 2 kb with the contact between the *Sox2* promoter and the *Sox2* control
region (SCR; dashed circle), and the model coloured by H3K27ac and by H3K4me3 with *Sox2*'s start
codon circled; base pairs, *Sox2*'s start codon and next four codons over its 5′ UTR, GC content
and CpGs. Maps marked "smoothed 3 × 3" are averaged over 3 × 3 bins before the ratio is taken.
**d**, Visualization and analysis alternate, and analyses chain across dimensions. Borders
detected on the map by diamond insulation (10-kb bins, 100-kb window; 7,743 borders and 7,723
domains over the autosomes and X) become a track and a feature set; CTCF ChIP-seq is piled up at
the borders, ranked into quarters by border strength (fold enrichment within 1 kb of the border
over the flanks beyond 80 kb), and the domains the borders delimit are rescaled and piled up on
the map against matched controls (observed/expected). A 3D model inferred from the map
(pastis-NB, chromosome 3, 624 beads of 250 kb) is coloured by the CTCF track and compared back to
the map (Spearman ρ between contacts and inverse model distances). Commands are abbreviated; the
full ones are in the console and in the Methods.

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
| file types and analyses (**b**) | 3D 3 and 3; 2D 9 and 18; 1D 15 and 9 — 27 file types, 30 analyses | Supplementary Tables 2 and 3 |
| borders, domains | 7,743, 7,723 (chr1–19 and X, 10-kb bins, 100-kb window) | `results/insulation/*.bed` |
| CTCF at the borders, by quarter of border strength | 1.85×, 1.61×, 1.45×, 1.30× (±1 kb over \|d\| > 80 kb) | `results/metaplot/*metaplot.tsv` |
| domains piled up | 7,723, drawn on 0.7–1.4 observed/expected | `results/domains/*apa-0.tsv` |
| compartments, chromosome 3 | E1 at 250 kb, r = 0.715 with H3K27ac | `results/compartments/*components.tsv` |
| loops | 918 on chromosome 3, 4 in chr3:34–35 Mb | `results/loops/*.bedpe` |
| models (beads of the map's bins) | genome 1,014 of 1,063 (2.5 Mb); chr3 624 of 641 (250 kb); region 994 of 1,000 (10 kb); locus 200 of 200 (5 kb); gene 125 of 125 (2 kb) | `results/model-*/*fit.tsv` |
| ρ(contacts, 1/distance) | 0.94 on chromosome 3 (0.77 for the region, 0.75 for the locus, 0.72 for the gene, 0.53 genome-wide with the trans pairs) | `results/model-vs-map/*agreement.tsv`, `results/model-*/*fit.tsv` |
| colour ranges in **c** | genome −3.6 to −2.6 (log10); correlation ±0.9; region −4.1 to −1.8 (log10); locus ±1.4 (log2 obs./exp.); gene −3.5 to −1.3 (log10) | `make_figure.py`, from the maps |
| CTCF on the model in **d** | 0.28 to 1.30, mean signal per 250-kb bead | `make_figure.py`, from the CTCF bigWig |
| read for the view in **a** | 47.2 MB of the 7.03-GB .mcool | the browser's network log while `capture-ui.mjs` ran |

In panel **a**, *Model from the map* took 3.7 s in the browser.

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
- **The genome is 2.6 Gb**, chr1–19 and X, the sequences every analysis here runs on. The file
  also holds chrY, which makes 2.7 Gb; say which in the legend if the figure's label changes.
- **"30 analyses"** in panel **a**'s fourth point is Supplementary Table 3's count (9 + 18 + 3,
  the numbers in **b**), where an earlier draft said "over 30"; keep the two in step if the table
  grows.
- **The maps' colour ranges.** The genome map in **c** is clipped on its contacts between
  chromosomes (5th–99.9th percentile of their log values), the way a reader sets a whole-genome
  view, so that the chromosomes saturate and the plaid between them shows. The correlation and the
  5-kb observed/expected are drawn with the app's 3 × 3 smoothing, which their keys say, applied
  to the observed and the expected before dividing, as the app does; their ranges are the app's
  auto rule for a ratio (99th percentile of the distance from neutral). The other maps use the
  app's auto range (1st–99th percentile of the cells with contacts). The region column's insulation
  track is drawn at 250 points, each the mean of four 10-kb bins, so that 10 Mb reads in 27 mm.
- **The models' colours.** A model coloured by a track uses the app's rule (linear from the
  track's 2nd to its 98th percentile), here from pale grey to the track's colour, with the marked
  beads also drawn thicker — the marks at the gene sit in a few beads of 125. The gene's model is
  seen from the other side from the rest, so that the promoter and the SCR face the reader.
- **Fonts.** The SVG names Helvetica and Arial; this PDF was built on a machine with neither and
  embeds Liberation Sans, which has Arial's metrics. Re-run `svg2pdf.mjs` on a machine with Arial,
  or open the SVG in Illustrator, to embed Arial itself.
- **Panel a's model** is the one *Model from the map* inferred in the session, for the region in
  view (chr3:34.2–35.2 Mb at 5 kb); panel **c**'s models are `run_analyses.sh`'s, one per column,
  and panel **d**'s is chromosome 3 at 250 kb. All are pastis-NB on the same map.
- **The yeast version.** The first proposal drew the same four panels on the yeast micro-C demo;
  it is in commit 6f20b0b.

## Rebuild

```bash
npm ci && npm run build:cli
python -m pip install cooler pyBigWig numpy pillow

bash manuscript/figure1/run_analyses.sh          # results/: fetches ~8.9 GB once, then the app's command line
npm run dev -- --host 127.0.0.1 --port 5173 &
node manuscript/figure1/capture-ui.mjs           # ui-session.png: the real app, headless, reading from 4DN
python manuscript/figure1/make_figure.py         # figure1.svg
node manuscript/figure1/svg2pdf.mjs              # figure1.pdf and figure1.png
```

`make_figure.py` reads the inputs in `build/mouse/` (written by `run_analyses.sh`), `results/`
and `ui-session.png`, and the 1 kb of mm10 it spells out by byte range from iGenomes' FASTA
(cached in `build/mouse/` after the first read). `capture-ui.mjs` opens
`session/mouse_sox2.metacooler.json`, which reads the map and the ChIP-seq from 4DN's bucket and
the genes from `build/mouse/genes_chr3.gtf`. Each panel is one function, laid out in millimetres,
so a panel can be moved, dropped or resized without touching the others.
