## DONE

- [x] I want a new side panel (vertical, next to the File bar on the left side). This Annotation panel should contain all things that relate to Linear Annotations / Map overlays / Manual annotations (currently present in the foldable File left side bar). This panel should follow the same aesthetic as the left and right panels. 

- [x] When hovering on a track at the bottom or right of the heatmap, a single hairline should appear across the tracks and heatmap to indicate the position of the track. This should be a single line, not a crosshair.
- [x] When this happens, a tooltip with all values ACROSS the tracks at that position should appear. 
- [x] New tracks should be added by default to the RIGHT of the heatmap, not to the bottom. 
- [x] The color picker should open directly when clicking on the color icon next to the annotation label. 
- [x] Same for the track name, which should be in-line editable directly by clicking on its name. 
- [x] This means name and color should NOT appear in the per-track settings.
- [x] Make the height slider a pixel text box instead of a slider. The user should be able to type in the height in pixels, and the slider should be removed. Put style next to it to make it more compact.
- [x] Groups should be a drop-down menu instead of a text box. The user should be able to select from existing groups or create a new group.
- [x] Track limits should be up to 3 decimals, not more than that. Use the same "auto" rounding as in the right panel.
- [x] Remove scaling option for tracks. 
- [x] The track annotations should be draggable in the side panel to rearrange their order in the list. 
- [x] When clicking to "pick on map" manual annotations, the mode should be activated for multiple clicks, and the user should be able to click on multiple points on the map to create multiple annotations in one go. The mode should be deactivated when clicking "Done" or pressing "Esc".

-  [x] Also, in the tooltip when showing values for all tracks, do NOT show the name of the hovered track, as it is already clear from the position of the tooltip.
- [x] The pointer when hovering over the track values should be the same as the pointer when hovering over the heatmap (a black-filled arrowhead). 
- [x] The heatmap color scale is gone when tracks are shown
- [x] for tracks settings, limits are overflowing. Also, the "auto" should be just a clickable button (with a border that appears if it is active), not a tick box. Whenever the user changes the limits manually, the "auto" button should be deactivated.
- [x] Remove subtitles for each card in the annotation side bar ("Drawn on the map itself." or "Drawn on the bottom or the right edges, or both." etc). 
- [x] All side bars should be explicitely named: General, Annotations, and Aesthetics. They all should have the title as currently set for Annotations. They all should be resizable and foldable (currently Aesthetics is not foldable). If too narrow for the cards within the bars, each card should be scrollable within the side bar.
- [x] Resizing or folding the side panels should affect how heatmap + tracks are centered in the remaining space within the main panel. 
- [x] In dark theme, all should be dark EXCEPT THE CENTER PANEL (heatmap + tracks), which should NOT change at all! 
- [x] It should be possible to zoom in/out or drag the TRACKS, this should also affect the heatmap. 

- [x] A "whole genome" button in the genomes and chromosomes tables — the same place the root crumb leads, offered where someone is standing when they wonder. Not on a metacool's per-genome contigs table, where "the whole file" is not the question; "with all selected" waits on the multi-select item below.
- [x] The mark on the landing page, big, with the name and the tagline over the drop area; and small in the header, before the name.
- [x] No captions on hand-drawn marks any more — gone from the card, from the model and from the drawing.
- [x] Export for hand-drawn marks, in the Aesthetics export row's shape: lines as BED, loops as BEDPE, both read back by this app's own loader.
- [x] The Annotations panel scrolls as a whole. Every card was its own scroll box, because `overflow-x: auto` makes a box scroll in *both* directions and a flex item shrinks by default.
- [x] The FILE card's key column takes the width its keys need instead of a fixed 9rem.

- [x] The header mark is aligned with the name and bigger (26 px). The brand row was baseline-aligned, and an image's baseline is its bottom edge; all three items share a centre now.
- [x] The landing masthead is one line — mark and name, centred, 80% of the drop zone's width, both scaled by a single `clamp`ed font size.
- [x] The cooler's whole-genome read has the metagenome scan's progress bar and cancel, because it is the same pass over every pixel. The reader walks the span asynchronously now, which is what makes a cancel arrive at all.

- [x] Multi-select across the tables: tick any number of genomes or sequences, "select all" / "clear" over whatever the filters leave visible, and "show N selected →" opens them as one map — each on the diagonal, every block between them off it. `view=selection` with `genomes=` or `regions=` in the hash, so a selection is a link. The pair view stays for the links and clicks that already point at it; a pair is now the two-element case of this.

- [x] Lanes beside the map are draggable: the border resizes, the body reorders, and dragging *along* the axis still pans the map — the direction of the first movement tells the three apart, so no gesture was given up for another. Right-click a lane for its colour, its range, hide and remove.
- [x] Right-click the map for a menu that marks the cell under the pointer: vertical line, horizontal line, crosshair, loop — each showing the coordinate it would use — and copy coordinates.
- [x] Hand-drawn lines are continued into the lanes: verticals under the map, horizontals beside it, each on the axis it names. Loop anchors are small triangles on the outer edge of each stack, pointing back at the map.
- [x] A 20 px margin over the landing masthead.

- [x] A tabbed interface, with multiple concurrent sessions. Each tab is a real session — its own reader worker, its own annotation worker, its own stores, its own DOM — so switching one in re-parents a canvas rather than re-reading a file. The address bar names the active tab and nothing else; the rest of the strip is in `sessionStorage`, and a restored tab is *named* rather than opened, so eight remembered files cost eight labels rather than eight workers.

- [x] A second cooler in the lower-left triangle, dropped on a card in the Annotations column. The split is the *matrix* diagonal, so panning off it needs no rule of its own. GENERAL becomes File 1 and File 2, each closeable — closing the second returns to one map, closing the first promotes the second. Refused by name on a metacool, a different bin size, or a chromosome list that differs in count, order, spelling or length. One scale by default; "match depth" for two libraries of different depth, with a colourbar in each file's own counts.

- [x] A 1D genome browser with no contact map: a chrom.sizes, a bigWig, a bigBed or a feature file declares the assembly, and the axis becomes the whole genome end to end at one unit per base pair. Same tracks, same cards, same renderers — §8.4's one coordinate model is what made it possible. Locus box, feature search, click-to-zoom on a gene, ruler and readout, arcs for a BEDPE, inline range and group editing, stacked and overlay group presets, ⌘-scroll for a track's ceiling, export. Drop a `.cool` on it to become its map; close a map to fall back to one.

- [x] Tracks reorder by their grip, their arrow keys or by dragging the lane itself; a button fits them all into the space there is, in the proportions they are already in.
- [x] A drag on the genomic axis zooms, with no modifier — the tracks below it keep the drag-to-pan they had.
- [x] Chromosome boundaries drawn between sequences, and the ruler's bands keyed to the assembly rather than to what is on screen, so a pan does not repaint them.
- [x] The pointer is the black-filled arrowhead over the tracks too.
- [x] A slider for a track's ceiling, beside the two boxes that type it.
- [x] Track names larger; their settings smaller, quieter and under the name, revealed by pointing at the lane.
- [x] A file dropped anywhere in the middle of the window is imported.
- [x] Gene names in a band under the features rather than over them.
- [x] Tick boxes on each row, and a batch bar that groups, colours, resizes, hides or removes several tracks at once.
- [x] A colour swatch beside each track name that *is* the colour input.
- [x] One toggle in Aesthetics that hides every word on the tracks — names, ranges, feature names — leaving the ink.
- [x] The 1D browser's PDF is vector: paths and text through the same renderers, Helvetica for type, deflated. The heatmap's stays a raster, because a contact map is one.
- [x] Tabs with tilted sides, the active one raised and lit along its top edge.

- [x] A Sequences card under the Genome card: every contig, its length, a bar of that length against the longest, a filter above a dozen of them, and a click that goes there.
- [x] A slicker tab strip: the × on the tab under the pointer and on no other, with no border of its own; one session drawn as a title rather than as a tab.
- [x] The Plot card as marks — fit across, fit down, track text, track fill — with the export controls back on one line.
- [x] The value range under the track name, and editable where it is drawn: a text cursor over either end, a box in its place on a click.
- [x] The colour swatch beside a track name only while the row is pointed at.
- [x] A shared toggle for the shading under a track's line, in the browser and beside the map.

- [x] Everything the 1D browser had grown that the heatmap's lanes had not, ported by *moving* the implementation rather than copying it: the colour chip before a name, the range you can put a caret in, the autoscale button beside it, ⌘-scroll for a ceiling, the Groups card with its overlay and scale-each toggles, overlay lanes, a stretch button and a height box, and a bar marking each run of lanes that share an axis.
- [x] A drag across a lane's body sets its ceiling. The area stays where it was, faded, as the record of the range being left behind; only the top line follows the hand, and nothing is written until you let go.
- [x] One toggle for a hairline along the top of every track, in the plot's ink rather than the track's own colour.
- [x] `Reds` in the colormap picker.
- [x] A track moved to the right of the map turns round, so both stacks grow towards the matrix. A toggle, so a deliberately flipped track gets its own orientation back on the way home.

## FOR NOW



## FOR LATER


