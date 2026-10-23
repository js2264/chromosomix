---
name: ui-gallery
description: Drive the real app in headless Chromium and produce a gallery of screenshots of the UI — run after any change that touches what is on screen, and send the pictures to the reader.
---

# UI gallery

After any change to the UI — a panel, a cell of the deck, a control, a style — the reader
wants to *see* it, not read that tests pass. This drives the actual app and writes one PNG
per step; send those to the reader (as files, in the chat) and say what each shows.

## Run

```bash
npm run dev -- --host 127.0.0.1 --port 5173 &
timeout 60 bash -c 'until curl -sf http://127.0.0.1:5173/ >/dev/null; do sleep 1; done'
node scripts/ui-gallery.mjs gallery      # writes gallery/01-map.png … 19-compare-models.png
node scripts/ui-figures.mjs gallery-figures   # the analysis figures: 01-curve.png … 25-metaplot-heatmap-dialog.png, a table's scatter with its least-squares line at 14b
node scripts/ui-csp.mjs site gallery-csp      # not on the dev server: a *build* (`npx vite build`) under its Content-Security-Policy, served as Pages serves it — the yeast map, P(s) and cis/trans with every chart's tooltip hovered, the 1D browser from a workspace on a second origin; fails on any refusal, in the page or a worker, but its three controls, and on a map or a lane left without its data. `standalone` instead drives `dist-standalone/` from file:// (`npm run build:standalone`): site-map … site-browser, standalone-map … standalone-browser
node scripts/ui-tour.mjs tour                # the furniture: the landing page in both themes, every dialog, the drawers, the five columns, the deck, the 1D browser, a metagenome's tables, an error page, the embed, a laptop and a narrow window: 01-landing … 73-narrow-landing
node scripts/ui-audit.mjs                    # no pictures: measures the tour's surfaces for clipped text, overlaps, ragged right edges, captions under the contrast floor and §26.4 punctuation, and prints the findings
node scripts/ui-methods.mjs gallery          # Model from the map under each Method: m1 … m4
node scripts/ui-structure-look.mjs gallery   # the structure cell's gestures: g-ghost-*, r*, t1 … t6
node scripts/ui-stars.mjs gallery            # the deck's stars and empty cells: s1 … s8, s8a, s8b
node scripts/ui-deck-reads.mjs gallery       # headings under zoom, own windows, the maps card: h*, w*, c*
node scripts/ui-saves.mjs gallery            # every export through the save dialog: x1 … x3
node scripts/ui-marks.mjs gallery            # marks on the card and the model's key: k1 … k5
node scripts/ui-marks-hide.mjs gallery       # marks hidden and shown (§8.1): a row's eye, A off and back with a hand-hidden mark kept hidden, the map's menu on a rule, a mark alone and the rest back, the turned map's V, the 1D browser's menu and A there, the model's key and its menu on a marked bead, the palette's switch, dark: h01 … h14b
node scripts/ui-captions.mjs gallery         # figures saved with their caption on and off: t1 … t9
node scripts/ui-cards.mjs gallery            # cards moved by their headings, through every rebuild: c1 … c8
node scripts/ui-bacteria.mjs gallery-bacteria  # a bacterial chromosome from origin to compartments: b01 … b36
node scripts/ui-tracks.mjs gallery           # the Tracks card, points, the pointers, map first, a circle, genes: tr01 … tr24
node scripts/ui-deck-lead.mjs gallery        # a lone bed3d as its model, the first cell moved, hidden, back, and a workspace opened from its address with its first map second: l1 … l4, m1 … m6
node scripts/ui-copy-this.mjs gallery        # Copy this on every right-click menu, and the PNG each put on the clipboard: cp1 … cp9
node scripts/ui-stack-bar.mjs gallery       # the bar under the 1D browser's tracks on the yeast tracks demo: at rest and hovered, dragged down with every height printed and its ratio to the first, Escape mid-drag, a double click fitting the stack to the column, gone with the browser as a deck's lead, beside a map and in a deck: sb01 … sb07, sb05b
node scripts/ui-reframe-hint.mjs gallery    # how to zoom into a region, in the map's corner on hover: away and over, under the key, the legend off, the diagonal lock's one line, a turned map's stretch, the 1D browser under its ruler, the dark theme: rh01 … rh08
node scripts/ui-diagonal-slide.mjs gallery  # the diagonal lock on yeast IV: a free sideways scroll leaving the line, Space taking the lock (its toggle lit), a sideways scroll and a drag held on the diagonal, an ⌥-drag's box drawn on it, V stepped to still held, Space letting go: w01 … w08
node scripts/ui-lane-carry.mjs gallery       # a lane's grip carried to another map, a +, a tracks cell, an empty cell; a model's row on a +: lc1 … lc14
node scripts/ui-track-location.mjs gallery   # the location marks, a left lane growing away, Space, the File card and the star, card rows on a + and an empty cell: tl1 … tl13
node scripts/ui-fourc.mjs gallery            # the 4C form's exclude anchor region, and the profile with and without the anchor: fc1 … fc4
node scripts/ui-apa-diagonal.mjs gallery     # APA's form and runs (§18.2, §18.8): the form as it opens — observed / expected, two diagonals left out, the nearest loop at five, a track ticked, no Control or Ranking card — with its price, and its run; the nearest loop at coolpuppy's floor with the note on the loops left out; the Control card back for distance-matched; every loop raw; the Ranking card back for a feature set; the ATAC peaks on the diagonal with two diagonals left out and with none; every track unticked, still unticked after a run: ad01 … ad09, ad01b
node scripts/ui-trackcorr.mjs gallery         # Track correlation on the yeast demo's tracks (§18.8): the form with its price line, the result at 100 bp and at 10 kb windows, each run saying how many windows a track lacks, and the tracks demo's five bigWigs at 100 bp, a window any of them lacks left out of every pair as deepTools leaves it out: tc01 … tc04
node scripts/ui-deck-cells.mjs gallery       # a tracks cell's axis, both anchors' hairlines, cells renamed, a lane out of a tracks cell, one side of two carried, the Structures eye, a track beside the map in a tracks cell, the height bars: dc1 … dc24
node scripts/ui-correlation.mjs gallery      # the map's correlation at 4,096, 2,048 and 1,024 bins with its wait printed, the veil, a whole chromosome, the Compartments warning, yeast IV: co1 … co9
node scripts/ui-compartments.mjs gallery     # the Compartments table under cooltools and under the correlation, each printed: cp1, cp2
node scripts/ui-interarm.mjs gallery         # Inter-arm alignment's form, and its table, the enrichment after detrend beside the enrichment, on E. coli, on P. aeruginosa PAK (read from the zoo) and on B. subtilis 45 min into ParB induction, printed; on PAK the profile after detrend on the measurement's axis and the decay curves; then the ParB time course as one deck, its all-maps table drawn as the reach against the minutes in each map's name with its least-squares line, over every point and over a box drawn across the points under way: ia1 … ia9
node scripts/ui-loop-calling.mjs gallery     # Loop calling on the yeast demo (§18.8): its row before Pattern detection, both under `loop`, the form on 1 kb with the kernel's boxes empty and the run refused saying why, the half-widths typed and the price, a run's notes, the loops as a table, the loop spectrum and the contacts each λ-chunk asked, the loops as rings on IV and close up, then a 5 kb rung after the run — the typed kernel kept, reach and radius following the rung — and the same rung fresh, the kernel for 5 kb bins in its boxes: lo01 … lo15
node scripts/ui-arm-baseline.mjs gallery    # the score picker's arm decay on PAK: offered once the first open ticks the circle, both diagonals with arms off, the card, ori keeping it, a hover, expected beside it, the link, unticked and ticked, and not on yeast: ab01 … ab10
node scripts/ui-peaks.mjs gallery-peaks      # peaks called on a bigWig, alone and with a replicate: p01 … p13
node scripts/ui-task-segments.mjs gallery-segments  # every called set as one row: peaks as a track under ATAC, insulation's boundaries as a track and its domains as corners, A/B segments by name, the display moving a set onto the map and back, a reload keeping it, and the 1D browser's track with no display: s01 … s14
node scripts/ui-called-sets.mjs gallery-called  # insulation's three rows (§18.7): the score, the boundaries as a 1D track and the domains as corners along the diagonal, the display and look dropdowns in the drawer and on each row, points and short diagonal markers close up, the domains as long segments, a turned map, a reload, the 1D browser: cs01 … cs13
node scripts/ui-deck-maps.mjs gallery        # eight maps dropped at once, maps named in a task's tabs and all-maps tables, ori and arms on every map, rows of the Contact maps card reordered: dm01 … dm10
node scripts/ui-insulation-hicrep.mjs gallery  # the Analysis column with Reproducibility ready, then HiCRep's and insulation's forms and runs on the yeast deck: ih00 … ih10
node scripts/ui-overlay-maps.mjs gallery     # a loop set's maps field on a deck of three, a row and a file dropped on a map's middle, the batch box: om01 … om19
node scripts/ui-deck-drops.mjs gallery       # the header's + before back (§5.5) on the landing page and on a dropped cooler, its dialog, a map and a bigWig added by URL; a Files row let go on the second map's lanes and on a tracks cell, each cell outlined in the air; a store's rows (gallery/_drops-store.json) dragged out of the drawer onto the same two cells, its workspace row not draggable: dd01 … dd11
node scripts/ui-contacts.mjs gallery         # the breadcrumb's contacts box: 10M typed, the figure and a task on the drawn map, a deck's chevrons down and up, two files in one square, a Boost-HiC refusal and its two ways out: ct01 … ct18
node scripts/ui-stranded.mjs gallery         # P(s)'s four orientations on the lab's toy library: the .pairs binned on the fly, then a .pairs dropped on the .mcool's form, and an address: st01 … st09
node scripts/ui-turned-marks.mjs gallery     # the reader's lines on a turned map: a V on the band, straight on down the lanes, re-cut by a zoom, an arm from off the side; then a hovered bead's echo, the same V dashed: tm01 … tm06
node scripts/ui-task-refs.mjs gallery        # the Analysis column's ? on what a task re-implements (§18.1), on the yeast demo: the column with every row's mark printed, green or the text's colour, a green tip and an untested one, the pointer carried into the tip to its DOI, a click on the ? opening no task and pinning the tip, the 1D card, dark: tr01 … tr07
node scripts/ui-about.mjs gallery            # About's three tabs (§18.10, §22.4): Overview with the stamp under it, the Notebooks tab reading its stamps and with them — each page's line of what it found, when, from what and by which run, the stamps read from the site by the script and handed to the page, the laptop's unpacked from `notebooks/laptop.html` when one is committed or from the render `LAPTOP_HTML` names — the Licences tab, the row walked with Home, End and ←, one page with no stamp, dark, a laptop on the Licences tab with the stamp on screen, a phone: ab01 … ab09
node scripts/ui-dev-features.mjs gallery     # dev features (§29): the store tiles, the lab store, About and a .metacool refused without them, then the same four with them, About carrying no switch either way: d00 … d07
node scripts/ui-edit.mjs gallery             # the stage that edits the reference (§27, dev): the heading's word, the whole genome, a snap, a stretch selected and turned, the bow-tie zoomed, a drag with the map rearranged, a box, the set-aside menu, an undo, the heading edited, dark, and dev off: e01 … e14
node scripts/ui-edit-bar.mjs gallery         # the pieces bars as handles (§27.3, §27.4): a piece's readout, a sequence dragged onto another's end with ⇧, the join, a piece turned by a double click: b01 … b04
node scripts/ui-edit-order.mjs gallery       # the stage's sidebar cards, a whole sequence pressed, ↑ moving it, a grip dragged down the list, a piece let go between two sequences, review: o01 … o07
node scripts/ui-edit-putback.mjs gallery     # 300 kb of IV set aside as debris, then put back from its row: p01, p02
node scripts/ui-edit-share.mjs gallery       # an edit sent in a link and opened in a browser with nothing kept: s01 … s03
node scripts/ui-edit-export.mjs gallery      # the export card (§27.8): each text file written, the sequence, the map and the genes lifted, an AGP read back: x01 … x07
node scripts/ui-edit-metagenome.mjs gallery  # the stage on one genome of the mock community (§27.10): the picker, its contigs, auto, a contig sent and one brought in, its AGP: g01 … g08, g03b, g04b … g04d, g06b
node scripts/ui-edit-refine.mjs gallery      # suggestions placed finer than a 2,048-cell picture, at 1 kb, then taken in auto (needs `npx vite-node scripts/make-scrambled-demo.ts` first): f01 … f03
node scripts/ui-edit-closer.mjs gallery      # the stage closer than its picture's cell, read again from a finer rung (data/, see data/README.md): c01 … c03
node scripts/ui-edit-reassembly.mjs gallery  # the stage on the chrXVI–mycoides long-read assembly (§27.11, data/): the method's offer, the sequence's ends, auto, review, the AGP: r01 … r07, r02b, r06b
node scripts/ui-edit-live-dotplot.mjs gallery  # the stage's corner dot plot against the theoretical genome (data/), a streak hovered, redrawn through auto: l01 … l03
node scripts/ui-dotplot.mjs gallery          # the dot plot task (§28, dev) on the same assembly against its theory (data/): the form, the signed density, a streak hovered and zoomed, the streaks: d01 … d06, d04b, d04c, and the PNG export under files/
node scripts/ui-ideogram-junctions.mjs gallery  # the hg19 ideogram, a BAM's sashimi arcs and two samples' STAR junctions at RPL10, FLNA's reverse arcs, chrX whole, the junction and band cards, the Tracks card's rows, colour by annotated at DDX3X, a band typed, the karyotype, a regtools BED dropped, the dark theme, the yeast karyotype on a map's edges and EFB1's arc: ij01 … ij17
node scripts/ui-vector-pdf.mjs gallery      # the Export card with PDF (vector) and no resolution, then the map's, the deck's and the model's PDFs kept whole, each rendered with poppler and its images counted: v01 … v05, v-map.pdf, v-deck.pdf, v-model.pdf, *-page.png
node scripts/ui-loci.mjs gallery             # every locus a reader sees or types, 1-based: bookmarks, marks, the map's menu, 4C's anchor, its lane and the console's line, FRiP per feature, a genome view's box: lo01 … lo10
node scripts/ui-fixes.mjs gallery            # the shortcuts' gestures, the circular column, a cis block slid along its diagonal, a thirteenth rung refused, a picker tab's status bar, a variant lane's menu, a .hic's normalisation, a map closed into the browser, what Pattern detection, APA under chromosight and Compartments say they will read, the palette's Annotations row on a metacool, an embed's landing page and palette: fx01 … fx17
node scripts/ui-structure-names.mjs gallery  # a BED's names on the model (§25.5): the colour-by menu with `· names`, the model A/B with its key, A recoloured from the key and the lane by name taking it, thirty names folding into `other`, the dark theme: sn1 … sn6
node scripts/ui-orfs.mjs gallery              # a FASTA's six reading frames: the setting off and on, UTP5's start with an amino acid in every codon, the readout over it, bare codons, start/stop ticks at 20 kb, the whole chromosome's "zoom in", one window in table 1 and in table 4 (TGA → W), a reload, dark: o01 … o13
node scripts/ui-motif-range.mjs gallery       # Find a motif over references read by range (§8.8, §8.21, §18.8): an 80 Mb FASTA with its .fai written under out/motif-range/ and opened alone, its row, the form with every sequence ticked and the scan's price, a run mid-way, the sites, one sequence ticked and its own row, then the yeast demo's .2bit priced and searched, and the FASTA held whole: mr01 … mr10
node scripts/ui-paper-store.mjs gallery      # the lab store's paper card, staged first (`python3 scripts/make_rsg_store.py stage --out gallery/stage --local http://127.0.0.1:5173`): Fig. 1a's three cells — GM12878 at 2 kb with its lanes and marks, the tracks cell its workspace fills, the model coloured by distance to its pinned bead — the tab strip, the same tab after a reload, Fig. 2 on chr19 with nothing computed, Fig. S3c: ps01 … ps05
node manuscript/figure2/chromosomix_panels.mjs   # Fig. 2's chain run in that tab from the Analysis column — insulation, peaks, APA of each peak with the next at 2 kb, the two metaplots — each figure saved by its own PDF button into manuscript/figure2/chromosomix/, the drawer shot after each run into gallery/figure2/: c0 … c5
node scripts/ui-edit-dotplot.mjs gallery     # the stage's corner dot plot in the hand (§27.3, dev; the chrXVI–mycoides data and a config under out/reasm/): its own size, zoomed by the wheel, moved by a drag, a contig's name hovered on the bar and its lines lit, a line hovered and its contig lit on the map, sized by its grip, the dark theme with the size kept: o01 … o07
node scripts/ui-basemods.mjs gallery         # a nanopore BAM's MM/ML calls on yeast IV: colour by base modification in the card, the reads by 5mC across UTP5 and its bare promoter and closer, a hover on a call and its read's card, 5hmC and 6mA picked, the depth row as % modified and its card, a 0.9 threshold, the dark theme: bm01 … bm14
node scripts/ui-revisit.mjs gallery          # a place visited again, drawn from memory: chr1, chr2, chr1 again, a window and chr1 again on the lab's mouse .mcool at 10 kb, then on a chicken .hic, each step timed with its requests and the memory figure, and the read panel on a revisit: rv01 … rv11
node scripts/ui-panel-keys.mjs gallery       # the digit row and the resolution keys on QWERTY and AZERTY: 1–4 and the key left of 1 folding the columns, Shift and Caps Lock, Ctrl and that key for the console, the shortcuts dialog, − and + walking E. coli's ladder with the map focused, rungs the reader added and a dropdown ladder, AZERTY's minus on its 6 key, the caps at 3×: pk01 … pk21
node scripts/ui-view-keys.mjs gallery        # the view's keys on QWERTY, a French PC and a French Mac: < and > stepping IV → III → IV → V (the comma and full stop bare, AZERTY's own key, a Mac's Backquote that must not fold Files), Page Up ×4 and Page Down on the focused map, 0 and à refitting from anywhere, e the O/E, f the fill, m the breaks, b a bookmark and its card, ? the dialog, Control with < and > walking two tabs: vk01 … vk14b
node scripts/ui-colour-picker.mjs gallery    # the colour picker (§26.6) on the yeast micro-C demo: a track's swatch opened hex first, a drag across the square held mid-way with the lane recoloured, still open after the drags, a hex typed, the next swatch offering the colour just picked and a chip applied, a lane label's swatch under the map, the dark theme: cp01 … cp08
node scripts/ui-structure-scale.mjs gallery   # a model coloured by a track (§25.5): its own ramp, white to the track's colour, the key's top end typed into and the lane following, a bottom past the top refused, autoscale again: sc01 … sc05, sc02b, sc04b
node scripts/ui-compare-modes.mjs gallery     # two maps in one square (§5.7, §7.5, §20.5): split, ratio and split again on the cooler's own `log10` and default ramp, ratio → difference → split, the second map's eye under a ratio, a ratio from a link put back to split, then a Files row dragged onto *Load a map into the lower triangle*: cm01 … cm09
node scripts/ui-map-look.mjs gallery          # the map's look and what leaves it (§7.1, §7.2): the key's short ramp on one map, on a split pair and on their ratio, the lines between chromosomes at 2×, then the dark theme and its exports — the map's PNG and PDF and a task's figure from the stage dialog, each on white, written under files/: lk01 … lk10
node scripts/ui-locus-pairs.mjs gallery       # two windows typed as one (§5.4): a space, ` x ` and `|` between them in the region box, each opening IV × V, the box showing the pair and Enter on it not moving, `I x II` in the whole genome's box, a pair in the Chromosomes table's: lp01 … lp05
node scripts/ui-history-list.mjs gallery      # the list of steps back beside the header's back (§5.5): five steps taken, the list, a row three back pressed, a reload and the list still there, Back and the list one shorter, the dark theme: hl01 … hl04
node scripts/ui-task-filter.mjs gallery       # the box over the Analysis column's task list (§18.1): the column, `TAD`, `pileup`, `a/b`, a word nothing matches, Escape, and Enter opening the first task left: tf01 … tf06
node scripts/ui-run-row.mjs gallery           # the drawer's run row on the yeast deck (§18.1, §18.4): P(s) with `run on ★` and `run on all 2 maps`, Peak calling with one plain `run` under either star and its form unchanged by the star, its peaks one row beside the first map, P(s) stale after a pan and the peak call not, then no map starred — P(s) refused, the column's warning, the 1D card live, Peak calling's Run live: rr01 … rr09, rr08b
node scripts/ui-metaplot-heatmap.mjs gallery  # the metaplot's per-feature heatmap as one smoothed image (§18.13): ATAC over its peaks, close up, the pointer over it with nothing lit, enlarged, and its PNG and PDF under files/, the PDF checked for one interpolated image: mh01 … mh05
node scripts/ui-installed-folders.mjs gallery # folders kept by the installed app (§20.6), with a stand-in folder dialog and display mode: run2 connected, a map and a track opened from it, the workspace saved (files/), reopened in a fresh window with nobody asked; another installation asked to connect run2 and finding it; and a tab's folder for this visit, gone after a reload: if01 … if06
node scripts/ui-allow-telemetry.mjs gallery  # *allow access* (§5.6) and telemetry (§31): the yeast cooler and its ATAC bigWig dropped with stand-in grants, a reload that asks first — the picker's callout and its primary button, *allow access to all 2 files*, in place of the red note — one press bringing back the map and its track; then a browser that grants one file a click: the map back, its track's row still asking (`allow access` / `or re-open this file`), and allowed; then the site built with `TELEMETRY_ENDPOINT` and `TELEMETRY_WEBSITE` (Umami Cloud) and served as https://chromosomix.app by routing, every request to the endpoint caught and printed — the landing page's clause, a map, a track, P(s), a refused file, About lit and turned off, a map opened with nothing sent — failing on a file name, a cookie, a referrer or anything after off: aa01 … aa05, te01 … te04, telemetry.json
node scripts/ui-files-routes.mjs gallery     # the Files column against every kind of file a folder holds (§20.5), on the yeast demo's directory plus a PDB (run ui-saves.mjs first), a .bgz, a page of prose and five names nothing opens: each row offered or dimmed with its tooltip printed, the map from its row, a loop .tsv, a .g3d.gz and the PDB each added in one cell, the .bgz as a track, the workspace's one mark appending its tab, and the prose .txt refused as text: fr01 … fr08, fr01b
node scripts/ui-lane-corners.mjs gallery      # the tracks' names over the tracks or in the map's corners (§8.8): the yeast map as it opens, the name column off and every name over its track, the switch unpressed on the Tracks card (lc00, lc00b, lc00c); the switch pressed, its two corners close up, a caret opened on a name in a corner, the map's PNG and PDF under files/, a track on every edge (all four corners), the dark theme, the yeast deck with its corners and as it opens, and the switch pressed again, the names back over the tracks, and that map's PNG under files/: lc01 … lc11, lc09b
node scripts/ui-deck-sequence.mjs gallery     # a sequence picked on one deck cell (§16.3): the yeast deck's headings, V on the Hi-C cell (off the chain, on V alone), XII on the first map, a reload, and the window's ×: ds01 … ds06
node scripts/ui-scalogram-axis.mjs gallery    # the distance axis on a scalogram's lane (§18.12): the Scalogram run on the yeast demo, its lane beside the map and close up (range in kb, rules at the decades, words clear of the names), the map's PNG under files/, and the lane in the browser: sa01 … sa04
node scripts/ui-derived-tasks.mjs gallery      # every task at a resolution the reader added (§3.4, §18.4): 3 kb added to the yeast demo's 1 kb, Diamond insulation run (the drawer's `3 kb* bins`, the lane one value per 3 kb, the console's `--coarsen 3000`), P(s) from one summed bin, and back at 1 kb the result out of date: dt01 … dt05
node scripts/ui-browser-box-lanes.mjs gallery  # a box marked in the 1D browser, then the map (§8.1): the browser's wash, the box on the map's diagonal and the same wash over the tracks beside and under it (close up), a box off the diagonal washed on both stacks, and the map's PNG under files/: bb01 … bb05
node scripts/ui-figure-frame.mjs gallery      # a figure's frame, fit and legend (§18.13): P(s) in its black frame fitted to the task's window, at the size of the window, after a wheel along the abscissa (the ordinate refits, the ticks between decades), with fit pressed, as violins and as a histogram; then the yeast deck's two maps renamed to long file names and P(s) on both, the legend beside the plot in the drawer and the dialog, and its PNG under files/; prints each axis's labels and the plot's and legend's edges: fr01 … fr08
node scripts/ui-ratio-missing.mjs gallery     # a ratio of two maps where either has no contacts (§6): the yeast cooler against a perturbed copy written under gallery/ (a third of its pixels zeroed, the rest scaled by ½–2), as a ratio — every missing cell RdBu_r's middle, not the top of the scale — close up with the readout over one, and as a difference, which keeps its zeros; prints each picture's share of middle, top, bottom and paper: rm01 … rm03
node scripts/ui-compare-oe.mjs gallery        # the O/E under a ratio of two maps (§7.5): the yeast cooler against the perturbed copy, opened with the O/E on — a split, the toggle lit; a ratio, greyed and out, `e` changing nothing; a difference, lit again; the split — each step printing the button, the hash and the key, with a crop of the Map card: co01 … co04
node scripts/ui-metaplot-tracks.mjs gallery   # the metaplot over two tracks and one set (§18.8): ATAC and Pol II over the ATAC peaks, the profile and a per-feature heatmap for each track, the same peak on the same row of both, each close up, both in the drawer, the second enlarged; then ranked by score in two groups, a heatmap for each of the four curves; prints every figure's heading: mt01 … mt05
node scripts/ui-ps-floor.mjs gallery          # P(s) leaving out the first two diagonals by default (§18.8): the form as it opens, minimum separation 2 bins; the curve in the drawer; enlarged with fit pressed, its first point two bins out; then at 0, fitted, the diagonal's break back at the left edge; prints the axes' labels: pf01 … pf05
node scripts/ui-tab-walk.mjs gallery          # Tab through the fields of one kind (§26.8), each step printed: with the name column on (`u`), the lane names under the map and on into the stack on its right (one renamed on the way, Shift+Tab back over the crossing), the ranges' ends to past the last, the colour key's low end to its high (left alone, then typed: tw04b), a Tracks card row to the next, the 1D browser's names and ranges down its lanes (tw05b, tw05c), the yeast deck's headings and keys from one map to the next, a 3D key's bottom to its top: tw01 … tw09
node scripts/ui-tutorial.mjs gallery-tutorial  # the guided tutorial (§30) played from the landing page's button to its last step on 4DN's K562 set (4DNESC23ZYOF) and chr15, every step shot with its counter and title printed: the landing page and About, the welcome with the store drawer shut — left on 4DN beforehand, and opened by the first step on the lab's store all the same — a wrong accession typed (the name blinks) and the right one pasted from its copy button, the General and Aesthetics columns, the Analysis panel's three groups, the map as a correlation, Compartments and its saddle, two drags across the lit squares down to chr15:38,100,001-50,025,000 at 5 kb, O/E and 3 × 3 smoothing, insulation at four scales, the loop and the subTAD border marked, an insulation bigWig and the figure's PDF saved, a press on the grey, *back* to a done step, *skip tutorial* half way and *resume* from About, every track ticked, the console, the end in the dark theme, and About after *finish*: 01-landing … 59-about-again
```

The second script drives the part the first only passes through: the figures a task returns
(§18.13) — the slim strip, the settings dialog, every mark, a table filtered and sorted and
drawn as a chart, a matrix recoloured, a ⌘-drag over a heatmap and the double click that undoes
it, and the two figures that carry an aggregate: a pileup with a track profile along each edge
and a metaplot's per-feature heatmap. Run it after any change to `src/figures/`.

The third drives *Model from the map* under **both** methods (§25.6) and prints each fit table to
stdout as well as shooting it: the first gallery runs the task once, with whatever the form
defaults to, and stops where the drawer's table runs past the window — so the rows that say what
the negative binomial found, and the weighting control that only ShRec3D asks about, are exactly
what it cannot show. Run it after any change to the reconstruction or its form.

The fourth drives the structure cell's **gestures**, which a gallery of arrivals cannot show: the
ghost-opacity slider at each of four values (0 has to be *gone*, not pale), two long drags that
carry the model over the pole, the telomere toggle, the colour-scale picker appearing for a ramp and
not for levels, the three sticky mode buttons pressed, and the grips on the Structures card. It
prints what it found to stdout as well as shooting it, so a control that silently did not appear is
a line in the log rather than something to spot in a picture. Run it after any change to
`structure/three.ts`, `structure/camera.ts` or the cell's settings.

The fifth drives the **stars** of a deck (§16.5, §18.1, §25.3) and its empty cells (§16.9), on the
yeast deck demo (a cooler beside a `.hic`): the Aesthetics column's *Map* card following the star
onto a companion, a setting changed there reaching that map alone, the filled star pressed so that
nothing is starred — the card then says *every map* and sets them all, and the Analysis column greys
every task that reads a map under one warning, the 1D card keeping its own answers — an empty cell
taking a row dragged from the Tracks card, and two
structure cells — the 3D card naming the starred one under its title, then the other starred, then
neither. It prints what the card said at each step, so a card that did
not follow the star is a line in the log. Run it after any change to the stars, the Map card's
placement or `VacantPanel`.

The sixth drives what happens *between* two pictures of a deck (§5.4, §16.3, §16.9), at a
laptop's 1600 × 1000 with every column open: three zooms, printing the heading's height and every
side column's width before and after — they must come out exactly as they went in — then a
companion taken off the chain with a box drawn on it, which must read its own window (its cells
change, the first map's title does not) and give it back; then the Contact maps card listing every
map, a row of it dropped on an empty cell, a companion's eye closing its cell and opening it
again, and the × on a map's own cell hiding it — the cell staying as a tracks cell where a track was
drawn in it. Run it after any change to a view's heading, the side columns, `MapPanel`'s window or the
Contact maps card.

The seventh presses export buttons with the **save dialog** stubbed (§26.6) — a headless browser
cancels a real one the moment it opens — and prints what each asked it: the suggested name, the
Downloads folder, the type filter, and the bytes then written, with each card's line naming the
file under the name "the reader" typed; then, in a page with no dialog, the plain download. Run it
after any change to `ui/export.ts` or to an export button. Any script that waits for a `download`
event has to take the dialog away first (`window.showSaveFilePicker = undefined` in an init
script), or the export is cancelled before it starts.

The eighth follows the reader's **marks** from the Manual annotations card to the model (§8.1,
§25.5): two marks typed, the structure dropped, the colour-by menu's order printed, *colour by manual
annotations* and its key, a mark hidden from the key, one recoloured from it — with the card's row
checked to have taken the same colour — and one moved by typing over its row. Run it after any
change to the marks, the Manual annotations card or the structure's key.

`scripts/ui-marks-hide.mjs` drives the reader's marks **off and back on** (§8.1, §25.5) on the yeast
demo: four marks typed — a vertical line, a horizontal one, an arrowhead off the diagonal and a domain
on it — then the horizontal line hidden from its row's eye, every mark hidden with `A` and brought back
by it (the one hidden by hand must stay hidden), the map's right-click on the vertical line found by
its ink and *Hide this line* pressed, a double-click on the box's eye showing it alone and a second
bringing back exactly what the first put away, the turned map's menu on an arm of the V, the 1D
browser's menu on its rule and `A` there, the model coloured by the marks with the card's hidden row
faded on its key and a key row clicked (the card's eye must go dark with it), a bead Shift-clicked and
the model's menu on it, the palette's *Manual annotations* switch, and the dark theme. It prints the
card's rows and eyes, every menu's rows and the key at each step, so a surface that kept drawing a
hidden mark, or a heading that miscounted, is a line in the log. Run it after any change to
`annotations/manual.ts`'s visibility, the card's eyes, `ui/marksMenu.ts`, a painter's marks or the
hit tests that find them.

The ninth saves **figures** with the Export card's *caption* switch on and off (§7.2) and writes
the saved PNGs themselves next to the shots, through a stand-in dialog that keeps the bytes: the
map's figure both ways, a deck with a tracks cell both ways (the deck's figure takes the first map's
caption), and the 1D browser demo's figure both ways, whose one-line caption is its own. It prints
each figure's height, which must drop by the caption's room when the switch is off. Run it after any
change to a figure's caption or to a figure pass.

The tenth moves **cards by their headings** (§26.6) and then makes every column rebuild under them:
a card carried within Aesthetics (shot in the air, with its landing slot) and one carried into it
from Annotations, a zoom, a reload, the General column rearranged across its nested hosts, a press on
a heading (which must still fold it), ⌥↓, a second tab and back, a deck arriving (its 3D card must
land after the Map card), the palette's reset, and on the two-map deck the Map card carried to
General with the companion then starred (the card there must become the companion's). It prints
every column's cards after each step, so a card that did not come back is a line in the log. Run it
after any change to `ui/cardLayout.ts`, to a column's builder or to a card's heading.

The eleventh drives what the yeast demo cannot show, because it has no circle and no origin: *P.
aeruginosa* PAK from the DNA Bacterial Zoo read as circular on its first open, *Origin and terminus*
and *Base composition* run from the Chromosomes table, the origin in the table's column, the map
framed on it with `ori` — lit while the origin is in the middle, through a zoom and not a pan, and
pressed again to go back to the sequence from its first base, each step printed to stdout — the O/E
taken along the arms with `arms` and correlated at 8 kb, the inter-arm and compartment tasks —
compartments by each *method*, the correlation's run with its own lane and components table after
cooltools' default —
*Base composition* again in a 1D browser holding the FASTA alone, at 10 kb (§8.15, §18.8) — and
then that browser's own Chromosomes table: a circle ticked and an origin typed there (and one past
the end refused), the map dropped over the browser taking both, and a fresh map's origin at its
first base, `ori` centring on it (§5.8, §8.15); and *Signal by group* comparing GC content between
the A and B the arms' compartments found, by the call's names and by E1's sign, with an origin typed
into the table first; and last, the DNA Bacterial Zoo as `scripts/dbz-store.sh` writes it (§24.2,
§24.3) — the cards, a species' fold, its session opening the map with the HiC score, insulation and
E1 along both arms under it and nothing on it, the circle and origin that session declares, `ori`
on that origin, and the shipped tile with nothing uploaded naming what builds it.
`GALLERY_ONLY=declarations`, `GALLERY_ONLY=groups` or `GALLERY_ONLY=store` runs one part alone,
in a minute or two. It reads the lab's bucket; where the browser cannot
reach it, serve the three files — `PAK_MM142.mcool`, `PAK.fa` and
`PAK_MM142_500.coverage.coverage-total.bw` — with `python3 scripts/DBZ_store.py serve <folder>` and
name the folder's address in `GALLERY_DATA`; for the store part, serve a store the script wrote and
name its `store.json` in `GALLERY_STORE`. Run it after any change to §8.15's declarations, to the
arm reading, to those tasks, or to the store's script.

The twelfth drives the **Tracks card and the lanes** (§5.8, §8.1, §8.6, §8.8, §8.15, §18.5): the
Annotations column's foot with Metadata annotations and Bookmarks folded, two tracks ticked and set
together from the batch box — `points` and one pair of limits — a diamond insulation run whose rows
land on the Tracks card marked `*`, the crosshair toggled off and on over a lane with the arrowhead
painted where the hand is (a screenshot carries no cursor) — `tr09b` magnified, its tip on the
hairline — the map's ring pointer painted the same way and a crop round it five times over
— `tr10b` at rest and `tr11b` in a cell wider than the ring, where the guide lines must stop at its
ticks and nothing may be drawn inside it — a typed locus with no ring round the map, the 1D browser
drawing points and its arrowhead on the hairline (`tr12b`, `tr12c`), the same session on a throttled
line drawing its map before
its tracks with their room kept, and a circle whose pan stops at its end, framed on `ori` and zoomed
on the join — then genes (§8.16): the rounded, pointed blocks beside the map and in the 1D browser, a
two-exon transcript (ACT1), the lane's right-click menu opened on a gene, the lane squished and
collapsed from that menu, and the same `rows` choice in the card. It prints what each step found. Run
it after any change to the Tracks card, the batch box, a track style, the pointers or the crosshair,
the order a session loads in, §8.15's frame, or how a feature is drawn.

The thirteenth drives the deck's **first cell as a cell like the others** (§16.9) and a structure
file opened on its own (§25.3): a bed3d written from the demo's model dropped on the landing page —
which must open as the model alone, filling the column with no scroll, the empty 1D browser it names
hidden behind it — then `show the 1D browser` in the deck's bar, the browser's heading with its grip
and its ×, the browser moved by its grip and hidden again; and on the yeast deck the first map moved
to the other cell, hidden by its × — the other map alone, starred, the first map's row on the
Contact maps card dimmed with its eye dark — the locus box typed with it hidden (the map on screen
must follow), and its eye putting it back where it stood. It prints the grid's order, the hash, the
star and the card's eyes at each step. Run it after any change to the deck's grid, its lead, the
Contact maps card's eyes, or what a lone structure opens as.

The fourteenth presses **Copy this** on every right-click menu that has it (§7.2) — the map, a lane
beside it, a lane of the 1D browser, and a 3D model after a right click that does not drag — with
the clipboard stood in for by a `navigator.clipboard.write` that keeps the PNG it is handed, as the
saves gallery keeps its dialog's bytes. It writes the menu as it opened and the copied PNG itself,
which must be the data object alone: the map's cells with no axis, key, frame, overlay or pointer
(`cp3` is the same map on screen, to hold it against); one lane with no name, range, handle or name
column; the model with no centre of rotation, key or buttons. It prints each PNG's size and what the
corner said. Run it after any change to a right-click menu, to what a renderer draws round its data,
or to `copyPicture`.

`scripts/ui-arm-baseline.mjs` drives the **baseline along both arms** (§7.5, §8.15) on *P.
aeruginosa* PAK at 8 kb, opened on its chromosome for the first time — so the circle is ticked by
the first open after the view is built, and the score picker has to be *told* to offer `arm decay`
(`ab01` is the picker opened out as a list, since a native dropdown's popup is not in a
screenshot). Then `arm decay` from the first base with `arms` off — both diagonals over the whole
square, the O/E and `arms` greyed with their reasons, the key `Arm decay` — then `ori` pressed on it,
which must keep the score, a hover's readout, `expected` beside it for the one diagonal it has, and
`ori` pressed again, which must keep that one; then a link naming it, the circle unticked on the
Chromosomes table (the entry goes and the link lands on counts) and ticked again, and the yeast
demo's picker without it (`ab10`). It prints the picker's options, the key, the toggles and the hash
at every step, so a score an `ori` press dropped is a line in the log. Where the browser cannot
reach the zoo, serve `PAK_MM142.mcool` with `python3 scripts/DBZ_store.py serve <folder>` and name
the folder in `GALLERY_DATA`. Run it after any change to the score picker, to `render/derive.ts`'s
baselines, to `analysis/arms.ts`, to `ori`, or to how a circle is offered.

`scripts/ui-peaks.mjs` drives **Peak calling** on the 1D browser demo's ATAC bigWig (§18.8): the task
on the 1D card, its form, a run on the one track — the note that says no test was made, the violin of every
candidate's curvature on a log axis — then the strongest 5,000 with the cut drawn as a second violin
and the table per sequence, the new lane under the MACS2 peaks of the same reads at the demo's locus
and at 8 kb, where they can be compared peak for peak; then Pol II as the replicate, shot mid-fit
(*IDR, round N*, with the cancel button), and its answer: the note naming each edge of IDR's
parameter box the fit ended on — Pol II is not a replicate of ATAC — the four violins, the six
thresholds and both lanes. It prints the notes of each run to stdout. The replicate run fits IDR
over the whole genome and takes two minutes. Run it after any change to the task, to `yapc.ts` or
`idr.ts`, or to how a figure draws a violin.

`scripts/ui-deck-maps.mjs` drives a **deck of many maps** end to end (§16.9–§16.11, §18.7, §8.15):
eight copies of the yeast cooler dropped on the landing page with a GTF and a FASTA, every one of
which must open in its own cell (printed, with a count of the cells that say *could not be
re-opened*, which must be 0); three copies of the *E. coli* demo renamed on their headings, run on
together — Inter-arm alignment's `all maps` tab with its stacked table, Reproducibility's shown once
— every map named by its name; the first map's card setting O/E and `arms` on every map with none
starred, `ori` framing every map across the junction, and a starred companion's own card; then the
Contact maps card's rows carried up and down it (shot mid-carry) and moved by the arrow keys, the
grid printed after each. `GALLERY_ONLY=drop`, `maps` or `order` runs one part. Run it after any
change to how a deck is filled, to the Contact maps card, to what a task names a map, to the
all-maps tab, or to how a companion reads a circle.

`scripts/ui-insulation-hicrep.mjs` drives the two tasks held to their references to the pixel
(§18.8) on the yeast deck. First the Analysis column as the deck opens, *Reproducibility* ready
beside the second map (§18.1) — it stood greyed there until another task had run — and then that
task **first**, on the fresh deck: its form and a run between the cooler and the `.hic`, the
coefficient matrix, the table per sequence and the correlation by separation, which starts at the
first diagonal. Run after insulation's, it would find the other map whether or not a first run
could. Then *Diamond insulation*'s form — its *Boundaries* section holding the diamond coverage the
calls are read over — and a run, with its lane and its domains on the map. It prints the row's
state, each run's notes and the per-sequence rows. Run it after any change to either task's form,
to `analysis/insulation.ts`, to `analysis/hicrep.ts`, or to how the deck tells the column its maps.

`scripts/ui-run-row.mjs` drives the drawer's **run row** on a deck (§18.1, §18.4), on the yeast
deck: *Contact probability P(s)*, which reads a map, offered `run on ★` and `run on all 2 maps`;
*Peak calling*, which reads only the tracks, offered one plain `run` with the first map starred and
with the `.hic` starred — its form's sequences the first map's both times, where they used to follow
the star — and run there, its peaks one row on the Tracks card named by no map, beside the first
map; P(s) run on the star and the view moved half a window, its heading stale with *recompute
here*, and the peak call's heading naming the tracks with nothing to recompute; then no map
starred: P(s)'s open drawer refusing with the column's sentence, the column greying every task that
reads a map and leaving the 1D card live, and Peak calling's Run live. It prints the run row, the
heading, the tabs, the column and the computed rows at each step. Run it after any change to the
run row, to the star, to `readsMap`, or to which map a task is framed by.

`scripts/ui-called-sets.mjs` drives a called set as **one row** (§18.7) on the micro-C demo's
chromosome IV: diamond insulation run, the drawer's two displays — and the look appearing beside the
boundaries' when they are put on the map from there — the map with the score and the boundaries' 1D
track on its edge and the domains' corners along the diagonal, the Tracks card's three rows, the
boundaries' settings as a track and on the map, their points and then their short diagonal markers
100 kb close, the domains back to a track of long segments, the map turned — corners standing on the
axis, points resting on it — a reload keeping each row's display and look, and the 1D browser demo,
where a peak set is a track and offers no display. It prints the drawer's dropdowns and every row's
display and look. Run it after any change to `analysis/surfaces.ts`, `ui/calledSurfaces.ts`,
`drawDiagonalFeatures`, or where a task's sets open.

`scripts/ui-overlay-maps.mjs` drives which maps an overlay is drawn on (§8.1), on a deck of three
yeast maps it writes itself (`gallery/_overlay-deck.chromosomix.json`, served beside `demo/`): the
loops row's *maps* field and the deck at each state — imported onto the first map, the Hi-C map's
mark pressed, *every map*, the first map's mark pressed off, *no map* — then the two drops onto a
map's middle, *on this map*: the loops row carried onto the Hi-C map, with the middle the only
rectangle lit for it, and a loop *file* dropped on the third map, all five lit, which opens there
alone. Dispatched with a real `DataTransfer` rather than dragged by the mouse, so the rectangles
can be shot while the hand is still in the air. Then the ATAC row's *location* beside it, the batch
box's two fields with both rows ticked, and the Analysis column's *Compartments* and
*Reproducibility* rows. It prints the lit marks, the lit rectangles and the count at every step.
Run it after any change to `ui/lanePlacement.ts`, to how `MatrixPanel` paints its overlays or takes
a drop, or to `AnnotationStore.overlays`.

`scripts/ui-contacts.mjs` drives the **contacts box** at the end of the breadcrumb (§6.5): the yeast
micro-C as stored, its own total in grey; `10M` typed and the map redrawn from ten million contacts;
a figure saved with the caption that says so, P(s) run on the drawn map with its framing line and the
console's `chromosomix … --contacts` printed; a total that is not one, refused in the box; the
box emptied. Then the deck demo, a cooler beside a `.hic` whose total is counted: the chevrons
pressed down and up (through Boost-HiC), and the deck's figure. Then two files in one square — the
second named in `GALLERY_PAIR`, since the demo has no second yeast map with the cooler's sequences —
with the Map card's fields printed to show *match depth* is gone. Last, E. coli at 1 kb asked for
500M: the Boost-HiC refusal, *read as stored*, and the same total at 2 kb. Every step prints the
box's value, placeholder, title and chevrons, and the hash. `GALLERY_ONLY=map`, `deck`, `pair` or
`refusal` runs one part. Run it after any change to the box, to resampling, or to what names a drawn
map.

`scripts/ui-stranded.mjs` drives **P(s)'s four orientations** (§18.8) on the lab's toy *Lachancea
kluyveri* library at the root of the `rsglab-data` bucket, which is there as a contact list and as the
`.mcool` binned from it. First the `.pairs` opened and binned on the fly: the form with *four
orientations* on, which must ask for no file, the price line naming the import the curves were counted
in, and a plain Run's figure — four unbroken curves, with no notch where they fell by half together.
Then the `.mcool`: the drop area empty, lit under a drag, holding the dropped `.pairs`, the run's
figure from it (the same convergence as the binned road, printed), and the bucket's address typed
over the file. It prints the *From the .pairs file* card and the price line at each step, and each
run's notes. The contact list is 330 MB and is read twice on the binned road; where the browser
cannot reach the bucket, serve a folder holding the two files under their bucket names and name its
address in `GALLERY_DATA`. `GALLERY_ONLY=binned` or `matrix` runs one part. Run it after any change
to the orientation figure, to P(s)'s form or estimate, or to a `file` parameter.

`scripts/ui-ideogram-junctions.mjs` drives the **karyotype and the junction lanes** (§8.22, §8.23)
on the human chrX demo, which opens the 1D browser from the hg19 cytoBand alone: RPL10 as the
session opens it — the ideogram, the genes, the BAM's depth with its own arcs, and two samples'
STAR junctions on one typed axis — then FLNA beside it, where the reverse strand's arcs hang below the
line, and the whole of chromosome X. It clicks the strongest arc (found by its colour) and the band
under it and prints both cards, opens the Tracks card's rows for the three kinds, colours the GBR
junctions by `annotated` and lets its axis go to the window before DDX3X — the 3′ end shot again,
where the novel acceptor three bases from the annotated one parts from it — types `Xq13` in the locus
box and prints the hits and the window Enter opens, shows the whole genome at `*`, drops the regtools
BED of the same sample, and opens the session again in the dark theme (the whole page: the figure
stays on paper, §16.5). Then the yeast map with its karyotype on two edges, CEN4's waist at 449 kb, and
chromosome I with EFB1's arc beside it, from a session it writes to `demo/yeast/` and removes. It
prints every row, card and hit it met. Run it after any change to `render/ideogram.ts`,
`render/junctions.ts`, `render/sashimi.ts`, the two parsers, or the band search.

Those last two of the first script need a form filled in before the run, which is why they are driven by name rather
than by position: an APA returns a pileup, a loop spectrum *and* a table, so "the last chart on
the page" is the scatter and not the picture. And the wait after pressing Run is that **the list
of figure titles changes** — waiting for a chart to exist returns at once, since the drawer still
holds the last task's, and waiting for the form to go away never returns at all, the form being a
slot that is emptied and refilled rather than removed.

Playwright comes from the global install when it is not a dev dependency (`npm root -g`), and
Chromium from `PLAYWRIGHT_BROWSERS_PATH`; the browser is launched with software WebGL
(`--use-angle=swiftshader`) so the structure cell renders in a container with no GPU.

The three after *Copy this* drive the gestures a gallery of arrivals cannot show. **Lane carry**
takes a lane by its grip with real pointer moves — a pointer drag captured on the lane's canvas,
which no `dragover` hears — and lets go on another map's rectangle, on a `+`, on a tracks cell and
on an empty cell, printing each cell's lane stacks before and after, so a lane that landed but did
not *leave* is a line in the log; it finds the grip by hunting the lane canvas for the `is-grab`
hand. **Track location** drives the four location marks on one map and on a deck, a left-hand lane
(which must grow away from the map), a pan off the diagonal put back by Space, the General
column's File card before and after the star moves to Hi-C, and a Tracks card row dragged — a real
HTML5 drag, not dispatched events, since a cell that refuses `dragover` never gets a drop — onto a
`+` and onto an empty cell. **4C** fills the anchor, runs the task with *exclude anchor region*
off and on, and shoots the left-hand lane each time.

The last three were written for the audit that made the PDFs drawings and every coordinate
1-based, and each prints what it found as well as shooting it. **Vector PDF** keeps each PDF whole
through the stand-in save dialog (`ui-saves.mjs`'s, which keeps the bytes of any file rather than
of a PNG), renders its first page with `pdftoppm` and counts its images with `pdfimages -list`: a
map's PDF holds one image, the cells, and the model's holds none — a figure that went back to being
a screenshot in a page is a count in the log. **Loci** types and reads back every box a locus goes
through and prints each card's rows; the genome view is opened in a context of its own, because
the app restores the tab the page above it had. **Fixes** reads the pointer's readout under a
sideways scroll on a block of two stretches of one sequence — both coordinates must move by one
distance and the separation must not — and drops a VCF on the Tracks card's own zone: the first
`.ann-drop` in the column is the Contact maps card's, which takes any file for a map.

## What it drives

The yeast demo (`?config=…/demo/yeast/Yeast_microC.chromosomix.json`), the square map, the
side panels folded for room, then: the demo structure dropped on the Structures card,
the cell framed on the maps' window, a hover on a bead (the status bar names it) and on the map
(the chord), colour by the first track, a tracks cell with two tracks placed on it, the Analysis
panel, the spatial-tracks task run, the reconstruction (*Model from the map*) run and landing
in the cell, the Structures card with both models, and the 3D card naming the starred cell. **Look at every screenshot** — a blank cell, a stale
note or a squashed plot is a bug the tests did not see, and this is where it shows.

`scripts/ui-tutorial.mjs` plays **the guided tutorial** (§30) end to end, the way a reader would: a real press on each lit control, a real Shift-Alt drag across the square the tour lights, so a step whose target the grey covers fails here as it would fail a reader. It reads the 4DN store from the deployed site — the dev server has no `stores/` — or from a folder holding `4dn.json` and `4dn-sessions.json` named in `GALLERY_STORES`, and the map and its tracks from 4DN's bucket, so it needs the network: a machine behind a proxy names it in `HTTPS_PROXY`, which is handed to Chromium as its own `--proxy-server` flag (Playwright's option proxies the loopback, and so the dev server, too). Each shot waits for the page's requests to land — a map still arriving from the bucket is a blank square under a card about it — and for the ring and the card to stop moving. It takes about four minutes. Run it after any change to `ui/Tour.ts`, `ui/tutorial.ts`, or a control a step lights — a renamed class, a moved button, a task's title.

## Gotchas met

- The Annotations panel is folded by default; its buttons are `button[title^="Show the … panel"]`.
- No card has a box to paste a URL into any more, so a file gets in by being **dropped**: fetch it
  in the page, build a `File`, and dispatch `dragenter`/`dragover`/`drop` with a `DataTransfer`.
  The click road opens the browser's own file picker, which the page cannot answer.
- The cell's own hover speaks in the status bar and on the maps, not in its corner readout.
- Vite serves `.gz` with `Content-Encoding: gzip` unless `vite.config.ts`'s dev plugin strips it.
`scripts/ui-motif-range.mjs` drives **Find a motif over a reference read by range** (§8.8, §8.21,
§18.8). It writes an 80 Mb FASTA of three sequences and its `.fai` under `out/motif-range/`
(git-ignored, written once) and opens it alone in the 1D browser, so it is past the whole-read line
and read through its index as a mouse genome is: the row's *read by range from its index*, the form
with every sequence ticked and the line beside **Run** pricing a scan in bytes and requests, a run
caught mid-way with its bar naming the sequence it is reading, the sites and their density, then one
sequence ticked — priced as that sequence — whose run lands as a row of its own. Then the yeast
tracks demo with its `.2bit` as a second sequence row: the form on the `.2bit`, priced at a quarter
of a byte a base, its sites at a locus, and the form on the FASTA held whole, still free. It prints
each price and each run's notes — the `.2bit`'s and the FASTA's site counts must agree. Run it after
any change to the motif task's form or estimate, `analysis/run/motif.ts`, or how the worker reads a
ranged reference.
`scripts/ui-orfs.mjs` drives a **sequence lane's reading frames** (§8.8) on the 1D browser demo,
with the General and Aesthetics columns folded so the browser is wide enough for each rung to land
where it would on a laptop: the FASTA row's settings before and after *reading frames* is pressed,
UTP5's start codon on chromosome IV at 120 bp — every codon with its amino acid, the gene's `M` in
`+1` — and the readout over it (found by the start's green, which must say *frame +1: ATG → M*),
1 kb of bare codons, 20 kb of start and stop ticks, and the whole chromosome, where the band says to
zoom in. Then one window in the standard code and in table 4, printing where its `TGA`s are so the
reds that turn to `W` can be checked against them, a reload that must bring the frames and table 4
back, and the dark theme (the whole page, then the ticks). Run it after any change to
`render/frames.ts`, `annotations/codons.ts`, or how the browser lays out a sequence lane.
`scripts/ui-basemods.mjs` drives **base modifications from `MM`/`ML`** (§8.13) on the yeast demo's
chromosome IV, from a session with its sequence and genes that it writes to `demo/yeast/` and removes,
with the simulated nanopore BAM `scripts/make-basemods-demo.mjs` wrote dropped on it beside its index.
It colours the pile by base modification and shoots the card with its key and the modification picker,
the reads by 5mC across UTP5 — the two nearly bare promoters are the blue bands — and closer, a hover
on the first strong red call (found by its colour) and the card its read opens, 5hmC and 6mA picked,
the depth row turned into *% modified* with its card and drawn as points up close, a 0.9 threshold,
and the dark theme. It prints the rows, the picker's options, the hovers and the read card. Run it
after any change to `annotations/bam/basemods.ts`, the pile's colourings or the depth's road.
`scripts/ui-revisit.mjs` drives **a place visited again** (§2, §12) — the walk a reader makes and the
one the kept answers exist for: on the lab's 689 MB `progenitors.mcool` at 10 kb, chr1, chr2, chr1
again, a window of chr1 and chr1 again, then the same on a 940 MB chicken `.hic`. Each step is timed
from the hash to the picture on screen, its requests to the data's host counted, and the status bar's
memory figure read; the table it prints is the one §12 quotes, and a revisit must show 0 requests in
well under a second. On the first revisit it opens the *read* panel, which must say the last view
cost nothing. It reads the lab's bucket unless `GALLERY_DATA` names a folder served with byte ranges
and CORS holding both files — a headless browser that cannot trust this machine's proxy needs that,
and a server that adds round-trip latency keeps the timings honest. Run it after any change to
`worker/answers.ts`, `worker/client.ts`, a view's reads, or the raster's pooling and colouring.
`scripts/ui-panel-keys.mjs` drives **the digit row and the resolution keys** (§5.5, §26.6) on two
keyboards. QWERTY is Playwright's own key presses; AZERTY is a French PC's, with the layout map
Chromium would hand over stubbed in an init script (so the Files badge reads `²`) and each press
dispatched as that keyboard sends it — `&` from `Digit1` bare, `6` from `Digit6` under Shift or Caps
Lock — since no headless browser can be given a layout of its own. On the yeast demo: `1` to `4`
bare, shifted and under Caps Lock, the key left of 1 with a folder connected (through the input a
browser with no directory picker opens), Ctrl and that key for the console, and the shortcuts
dialog; on E. coli's ladder, `−` and `+` and their other halves with the map's canvas focused —
which must re-read the same window at the next rung rather than zoom it, printed after each press —
to the finest rung and past it; on the yeast cooler, rungs added through the bar's `+` walked by
the keys, and a ladder past nine rungs, whose dropdown they walk too; and the badges at 3×, where a
superscript `²` must not pass for the `2` beside it. It prints which columns are open and what
each badge says, and the lit rung, the entry and the window after every press. Run it after any
change to `ui/commands.ts`'s matching, `ui/keyboardLayout.ts`, a column's key or badge, or the
resolution bar.
