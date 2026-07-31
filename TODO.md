## FOR NOW

- [x] Only `genomes` table is visible and opened by default when opening a file. It would be nice to have a way to open the `contigs` table if wanted. It could be done by using a dropdown menu to select which table to open here: 

![alt text](image.png)

- [x] Same thing with a mmetacooler, it could have a dropdown menu to select wich nested metacool it would open (inserted before the "> genomes"). 

- [x] I'd rather have the file info sidebar on the left side

- [x] When in contig or genome heatmap view, the bottom line that indicates coordinates of contigs/genomes is partially hidden, I need to scroll down to see it full. 

![alt text](image-1.png)

- [x] In the file info sidebar:  I like the layout of the BINNING QC div, but it's too prominent for the QC information, make it look like the READS and VALIDATION divs. Use the current BINNING QC style to wrap the FILE header+file info div (uri, layout, ...). Also, the READS and VALIDATION should look like the QC div, but stacked from the bottom of the sidebar, not from the top.

- [x] In the heatmap canvas, the names of the contigs/genomes are not displayed well (they appearh truncated on the left side, and not at all visible on the top side). Also, there is some leftover empty space at the bottom of the heatmap canvas. Also, I want to color bar to be displayed immediately the right side of the heatmap canvas, and not as tall!! just a small color bar, not necessarily the full height of the heatmap canvas.

- [x] Also, dropdown settings for viewing (scale, vmax, colormap, etc) could be displayed in a pretty div in a column style within the `aside` on top, and the CONTIGS would be underneath (and not visible when in contig view).

![alt text](image-4.png)

- [x] In the genome table, when we scroll horizontally to see the last columns, the headings don't scroll with the table, so we can't see what the columns are. 

- [x] The "Nothing you drop here leaves your browser" message should be closable 

- [x] Every field changed by the user should be remembered and restored when the user reopens the file. for ex, if i run a filtering on the genome table, then select a genome, then go back to the genome table, the filtering should be restored. 

- [x] when looking at a genome and clicking on the intersection of 2 contigs, the contig view currently opens a symmetric square map corresponding 1 of the two contigs. It should instead opens an assymetric, rectangular map of the intersection of the two contigs!



## NOTES ON THE BATCH ABOVE

- **Table state** is remembered per file and per table (genomes / contigs) in
  `sessionStorage` via `src/state/UiMemory.ts`: filters, free-text search, sort
  column and direction. Deliberately *not* in the URL — a shared link silently
  carrying "only rows where completeness > 90" would mislead whoever opened it —
  while genome, region, level and colour scale stay in the hash, because those
  *are* the shareable view (spec 5.5).
- **Heatmap gutters** are now measured from the labels that will actually be
  drawn (`HeatmapOptions.autoMargin`), capped at a third of the canvas. An axis
  with more contigs than `MAX_CATEGORICAL_TICKS` draws no labels and reserves no
  gutter, which is what removed the dead band under the plot. Pinned by
  `test/unit/heatmap-margins.test.ts`.
- **Contig x contig** is `view=region` with a second axis, `region2`. The two
  ranges resolve independently and the reader already handles the transpose when
  the column range precedes the row range in bin space (5.3), so this needed no
  new query path.
- **Heads-up on the batch below:** moving READS and VALIDATION into a status bar
  supersedes part of the sidebar item above, which just stacked them at the foot
  of the sidebar. The card styling and the File block stay; those two sections
  would simply move out.

## FOR NEXT 

- [ ] Populate a bottom status bar with a bit of information about the data read, and display all the information currently in READS in the left sidebar when hovering over it. Remove READS from left sidebar. 

- [ ] When hovering over cells in the heatmap, display the contig/genome pair names of the cell in a tooltip, and the values of the cell. 

- [ ] Validation should also be in the status bar with only "Validation" followed by a green tick (if ok), and clicking on it should trigger deep validation. Remove VALIDATION from left sidebar.



## IN FUTURE  

- M5

- M6

- M7, with specifically an option to view the FULL whole-genome (not just a region). This is currently against what specs/implementation say, but it would be nice to have an option to view the full genome in a single heatmap, even if it is very large.



