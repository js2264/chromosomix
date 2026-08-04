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

## FOR NOW

-  Also, in the tooltip when showing values for all tracks, do NOT show the name of the hovered track, as it is already clear from the position of the tooltip.
- [ ] The pointer when hovering over the track values should be the same as the pointer when hovering over the heatmap (a black-filled arrowhead). 
- [ ] The heatmap color scale is gone when tracks are shown
- [ ] for tracks settings, limits are overflowing. Also, the "auto" should be just a clickable button (with a border that appears if it is active), not a tick box. Whenever the user changes the limits manually, the "auto" button should be deactivated.
- [ ] Remove subtitles for each card in the annotation side bar ("Drawn on the map itself." or "Drawn on the bottom or the right edges, or both." etc). 
- [ ] All side bars should be explicitely named: General, Annotations, and Aesthetics. They all should have the title as currently set for Annotations. They all should be resizable and foldable (currently Aesthetics is not foldable). If too narrow for the cards within the bars, each card should be scrollable within the side bar.
- [ ] Resizing or folding the side panels should affect how heatmap + tracks are centered in the remaining space within the main panel. 
- [ ] In dark theme, all should be dark EXCEPT THE CENTER PANEL (heatmap + tracks), which should NOT change at all! 
- [ ] It should be possible to zoom in/out or drag the TRACKS, this should also affect the heatmap. 

