# Fig. 1 — a proposal

`figure1.pdf` (vector, fonts embedded, heatmaps as images) · `figure1.svg` (the editable master) ·
`figure1.png` (a 300-dpi preview).

180 × 170 mm: Nature's double-column width and its maximum height, which leaves the legend room
under the figure. Type is Helvetica/Arial (Liberation Sans, Arial's metrics, where neither is
installed — it is what the PDF embeds), 5–7 pt, panel letters 8 pt bold. Every element is vector
except the contact maps, the pile-up, the model-versus-map square and the UI screenshot, which are
images at 790–2,300 ppi with interpolation off.

## What it shows

| panel | idea | how |
| --- | --- | --- |
| **a** | The app itself | The real window: the yeast micro-C demo at IV:1.0–1.4 Mb, Diamond insulation and *Model from the map* run from the Analysis column, a deck of map, model and 1D browser. Five numbered points name what the paper claims of the session. |
| **b** | The whole spectrum of data | What is read and what is computed, by dimension, from Supplementary Tables 2 and 3. Colours are the figure's dimension code: 1D blue, 2D vermillion, 3D purple. |
| **c** | One coordinate system, every scale | One session from the whole genome (12.1 Mb) to single bases (500 bp at the UTP5 start). Rows are dimensions, columns are scales; each column zooms into the window marked in the one before (shaded on the tracks, outlined on the map, coloured on the model). The 3D model stops at its 5-kb beads, the map at its 1-kb bins, the tracks go on to the sequence and its reading frame — the staircase is the point. |
| **d** | Seeing and measuring, back and forth | SEE columns hold what is drawn in the view, MEASURE columns the tasks that read it. From one map, two chains cross every pair of dimensions in both directions: 2D→1D (insulation), 1D×1D (metaplot, correlation), 1D→2D (domain pile-up), 2D→3D (pastis-NB), 1D→3D (colour by a track), 3D→2D (model versus map), 3D→1D (spatial tracks). Each task shows its command; the dashed loop says every result is in the session for the next one. |

Panels **c** and **d** are the legend's two sentences ("one session browsed … at native
resolution" and "the analysis chains across dimensions …"), and draw nothing that the app did not
compute: every track, set, pile-up and model is an output of `metacooler-run` (`run_analyses.sh`),
and the three 3D models are inferred from the map — the demo's own `Yeast_structure.g3d.gz` is a
hand-made fixture (see `scripts/make_structure_demo.py`) and is not used.

## Proposed legend

**Fig. 1 | Chromlens integrates browsing and quantitative analysis of 1D, 2D and 3D chromatin data
in a web browser.** **a**, A Chromlens session in a browser tab, on mitotic micro-C of
*Saccharomyces cerevisiae*: files are read in place and never uploaded (1); only the region and
resolution in view are read (2); a deck shows the contact map with its tracks, a 3D model inferred
in the session and a 1D browser on one coordinate system, panned and zoomed together (3); analyses
run in a background worker and their outputs join the session (4); each step is logged as its
command-line equivalent (5). **b**, File formats read and analyses run, by dimension
(Supplementary Tables 2 and 3). **c**, One session browsed from the whole genome to single bases.
Each column zooms into the window marked in the previous one (shaded on the tracks, outlined on
the map, coloured on the model); the 3D model, the contact map and the linear tracks follow the
view down to the finest unit each holds: 5-kb beads, 1-kb bins and single bases. Circles, loops
called with Chromosight; colour on the locus model, Pol II ChIP-seq. **d**, Visualization and
analysis alternate, and analyses chain across dimensions. Borders detected on the map by diamond
insulation (531 borders, 515 domains genome-wide) become a track and a feature set; Pol II ChIP-seq
and ATAC-seq are piled up at the borders (fold enrichment at the border over the flanks beyond
8 kb) and the insulation track is correlated with Pol II (Spearman ρ over 1-kb bins), and the
domains the borders delimit are rescaled and piled up on the map against matched controls
(observed/expected). A 3D model
inferred from the map (pastis-NB, whole genome, 2,250 beads of 5 kb) is coloured by the Pol II
track, compared back to the map (Spearman ρ between contacts and inverse model distances,
chromosome IV; range over the 16 chromosomes) and turned into a radial-position track. Commands
are abbreviated; the full ones are in the console and in the Methods.

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
| borders, domains | 531, 515 | `results/insulation/*.bed` |
| loops | 1,100 genome-wide, 26 in IV:1.0–1.4 Mb | `results/loops/*.bedpe` |
| Pol II, ATAC at the borders | 1.6×, 4.1× (±100 bp over \|d\| > 8 kb) | `results/metaplot/*metaplot.tsv` |
| ρ(insulation, Pol II) | −0.35 (Spearman, 1-kb bins) | `results/trackcorr/*table.tsv` |
| model | 2,250 of 2,431 bins of 5 kb | `results/model/*fit.tsv` |
| ρ(contacts, 1/distance) | 0.89 on IV, 0.77–0.97 over the 16 chromosomes | `results/model-vs-map/*agreement.tsv` |

The whole chain ran in about 80 s here on four 2.1-GHz cores, 43 s of it the genome-wide model,
and insulation genome-wide at 1 kb in 3.4 s.

## To check before it goes in

- **The name.** The build still says (meta)cooler. `capture-ui.mjs` rewrites the header's word,
  and `metacooler-run`, to Chromlens in the page before the shot; nothing else on screen is
  edited. Re-shoot once the app carries the name, or set `BRAND` if the name changes again.
- **Data provenance.** The micro-C is the mitotic map of Dauban et al. (*Science*,
  doi:10.1126/science.adm9466), as `docs/deploy.md` records. The yeast ATAC-seq, Pol II ChIP-seq
  and MNase-seq tracks carry no accession in the repository; they need one in the legend or the
  Data availability statement.
- **Fonts.** The SVG names Helvetica and Arial; this PDF was built on a machine with neither and
  embeds Liberation Sans, which has Arial's metrics. Re-run `svg2pdf.mjs` on a machine with Arial,
  or open the SVG in Illustrator, to embed Arial itself.
- **Panel a's model** is the one *Model from the map* inferred in the session, for the region in
  view; panel **d**'s is the genome-wide model of `run_analyses.sh`. Both are pastis-NB on the
  same map.

## Rebuild

```bash
npm ci && npm run build:cli
python -m pip install cooler pyBigWig numpy pillow

bash manuscript/figure1/run_analyses.sh          # results/ — the app's command line, ~80 s
npm run dev -- --host 127.0.0.1 --port 5173 &
node manuscript/figure1/capture-ui.mjs           # ui-session.png — the real app, headless
python manuscript/figure1/make_figure.py         # figure1.svg
node manuscript/figure1/svg2pdf.mjs              # figure1.pdf and figure1.png
```

`make_figure.py` reads the demo files of `demo/yeast/`, the zoomified map in `build/` (written by
`run_analyses.sh`), `results/` and `ui-session.png`. Each panel is one function, laid out in
millimetres, so a panel can be moved, dropped or resized without touching the others.
