# Changelog

Notable changes to the viewer, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/) — for an application that means the **format and URL
contract** rather than a code API: a major bump is a `.metacool` the previous version could open and
this one cannot, or a `#`-hash link that no longer resolves to the same view.

The deployed site at <https://js2264.github.io/metacooler.js/> is built from `main` on every push, so
it can be ahead of the newest entry here. Its exact build is in **About → version**, and in the
`/Producer` field of any PDF it exports.

## [Unreleased]

### Added

- **Zooming sharpens the picture.** A block larger than the screen has arrived
  coarsened since pooling landed — a whole yeast genome at 1 kb is drawn at
  3.0 kb cells, and the note under it said so honestly and told you the remedy
  was to open something smaller. That was true and it was not the interaction
  anybody has in their hands. A zoom that **settles** past what the block can
  show now reads that window again at the grid the picture could show: on the
  demo yeast cooler, 3.0 kb becomes 1.0 kb on one bounded read, and on a file
  that size the read comes out of the chunk cache without touching the network.

  It changes one clause of SPECS §2 and leaves three standing, which is the whole
  design. There is still no tile server, nothing is cut into tiles, and no
  picture is ever assembled out of parts: what is drawn is always exactly one
  bounded block. **A gesture still costs nothing** — the read goes out after the
  window stops moving, never during it, and neither the renderer nor the panel
  holds a reader to issue it with. It **terminates**, because there is no grid
  below the file's own bins: one step for a whole yeast genome, three for a human
  chromosome at 5 kb, and *none at all for a MAG*, whose block already is the
  finest data in the file — §2's own case is untouched. And it is **bounded by
  the view**: a zoom can never widen past the domain the view was entered on, so
  it cannot become the full pixel scan §7.3 gates.

  Zooming back **out** is served the same way and is usually free: two or three
  whole blocks are kept, so leaving what a fine one covers falls back to a coarse
  one still in hand. The colour range is measured from the widest of them and
  does not move while you zoom in — coarse cells are sums of bins, so a finer
  block holds smaller numbers, and re-measuring would re-brighten the map for
  somebody who changed nothing but the magnification.

  It refines under an O/E map, under two files blended on the diagonal, under a
  45° turn, and in every panel of a deck independently — the last of those
  because the navigation lock's currency was always base pairs, so five maps at
  five resolutions were already in step. The one picture that does not refine is
  the genome × genome overview, whose axes are sequences rather than positions:
  a cell there *is* a contig, and there is nothing finer to go to.

  The moment it happens is **shown**, not hidden. Crossing the edge of what the
  block can show freezes the map — no pan, no zoom — and puts a spinner in the
  corner of the plot until the new grid lands, so the picture is exactly where
  you left it when it sharpens and the change is one you can watch happen.
  Escape calls the read off and gives the map back, so no file can lock it.
  Panning to the edge of the block reads the next stretch **at the same
  resolution**: panning is a change of place, not of scale, and getting that
  wrong hands a reader back a four-times coarser map for dragging left.

  The key in the corner now names the cell size, on its own line, and in
  exported figures too. It is the one thing about a refining map that the pixels
  cannot tell you.

  **Off by default**, because a zoom that reads is a zoom that can wait and §2's
  promise has always been that it does not. The switch is the first of the three
  on the map's `picture` row — three bars, coarse at the top, fine at the bottom
  — beside the 45° turn and the O/E baseline, and **Read finer data as you zoom**
  in the command palette does the same thing. Off is exactly the old behaviour.
  The note under a pooled map now ends
  `· zoom in to sharpen` or `· open a smaller block to sharpen` depending on
  which. `MULTIRES-ZOOM.md` is the study this came out of, with a closing section
  on where the built thing differs from the plan.

- **The resolution ladder drives the zoom (§3.4, §9).** "Wire the entries to the
  zoom control" has been in the spec since the first draft and in README's own
  list of gaps as *inferred but not driven*. A zoom now reads from the
  coarsest rung of an `.mcool` or `.mmetacool` whose bins still fill a cell — and
  never one finer than the level you opened, which is a choice the zoom does not
  get to overrule:
  fewer stored pixels for the same picture, and — the reason that matters — a
  balanced map that was **balanced at that resolution** rather than summed, which
  is what `zoomify --balance` produces and what the reader has been calling "the
  real answer" in a comment since pooling landed.

  The rungs a zoom touches are opened beside the one that is open, over the same
  mounted bytes, bounded at three and released with the session; a navigation
  still closes the map, because a navigation means the last place is finished
  with. Bin indices are not comparable between levels — five chromosomes of the
  demo `.mcool` have one fewer 2 kb bin than the division says — so windows cross
  through base pairs, per contig, with a whole sequence converting to its whole
  self at either end. None of it is required: a plain `.metacool` has no ladder
  and the zoom reads the open map, which is §3.4's own rule for what a ladder is
  allowed to be.

### Fixed

- **A pooled read drew the wrong column.** `SpanScanOptions` had no `value`, so
  every pooled, rolled-up and selection read walked `pixels/count` whatever the
  request asked for, while the dense path honoured the choice — one view showing
  two different quantities, decided by whether the block happened to cross the
  pooling threshold, with nothing said. It is threaded now, in the one place both
  paths meet. Latent since pooling landed; urgent once the resolution started
  moving with the zoom, because a quantity that changes as you magnify is not a
  picture of anything.

- **`bin × bin` in the whole-genome view.** The overview offered two levels and
  both put one cell per *unit*: a contig cell sums a rectangle of
  `length × length`, and a metagenome's contigs span several orders of magnitude,
  so the axis spends its width on the shortest sequences and its colour range on
  the longest. On the 48-MAG mock community that is 62% of the axis given to
  contigs under 5 kb holding 4% of the sequence, one badly-assembled MAG taking
  28% of it for 4.5% of the assembly, and a third of the diagonal coming out
  empty — a haze where the readable picture was one click away in the genomes
  table, as "select every row". That picture is now the third entry in the same
  picker. It is the pooled whole-file read the app already made, so the map, the
  resolution and the counts are identical to the selection's, down to the
  `4,057 × 4,057 bins · effective resolution: 50.0 kb`; what is new is that it is
  reachable from where the question is asked. `level` carries it in the hash like
  the other two, and the picker is one control shown at whichever level is
  mounted, so there is always a way back.

  It is also the **default**, which makes the other two changes obligatory rather
  than nice. Landing on a level means it must not read anything on its own: the
  gate is now unconditional there — the scan view's sentence, the cost, and the
  button — instead of appearing only above ten million stored pixels, since a
  threshold makes the rule hold on large files and lapse on small ones. And
  landing there means it has to be read the way the other two are, so the axis is
  labelled and divided by **genome** rather than by contig, with a label click
  opening that genome; 2,082 contig hairlines over 48 blocks were a grey wash over
  the structure the view exists to show. `contig × contig` stays one click away —
  "does this bin hold together" is a question only it answers — and where a
  catalog advertises a sidecar edge list the default still gives way to
  `genome × genome`, which is a small download rather than a pass over the file.

  A map of a *chosen* set of sequences is untouched: its axis names what was
  ticked. So is a plain cooler, which has no genomes and keeps its own view kind,
  its own level control and its `nnz` threshold.

- **A sideways scroll slides along the map.** Two fingers across a trackpad mean
  "along the genome" in every browser there is, and already did over this app's
  own 1D tracks; over a map they did nothing, because the handler stood aside so
  the platform's back-and-forward swipe would work there as it does over the rest
  of a page. That is the wrong trade over the one element a reader navigates *by*
  sliding — and the swipe still works everywhere outside the picture. Over a lane
  stack it means the same thing, since a stack is drawn on the map's own axis.

- **`v` cycles three pictures instead of toggling two:** the map and its tracks,
  the tracks alone, the map alone, and home. Nothing is hidden, moved or
  restyled on the way round — the map alone is the stacks drawing no lanes for as
  long as it lasts — so three presses come back to the arrangement you spent ten
  minutes on. The button offers the *next* stop rather than naming the current
  one, because it is a control and not a status light.

- **`[` and `]` step between sequences in the 1D browser**, as they already did
  on a map. It was the one view where the plainest thing anybody does with a
  genome had to be typed into the locus box.

- **A track's floor shows the resize cursor.** The double arrow every application
  uses for exactly that gesture, and the one the map's own box handles already
  showed — the drawn rule stays, since it is what says which lane the border
  belongs to, and the cursor is what says it can be dragged.

- **The O/E toggle survives a navigation**, as the turn now does. Both are how a
  reader is *reading* maps rather than facts about the block, and looking
  somewhere else is not a request to stop reading that way.

- **A map with a diagonal opens turned.** The band along a genomic axis with its
  tracks under it is what a contact map is *for* at this scale, and what every
  published figure of one looks like; the square is the special view — wanted for
  the far corners and for reading a comparison across the diagonal — so it is
  what a reader asks for rather than what they are given. The box opens as wide
  as the panel allows and a quarter as tall. Only the "no" is written to the
  link, so an ordinary view's hash stays short, and a block with no diagonal
  draws square without recording anything — a metagenome you passed through can
  no longer switch the turn off for every map after it. And the setting now
  survives a navigation, as the deck and the second file already did: dragging a
  box on the map to open a region, or clicking through Chromosomes to another
  sequence, used to come back square, which is exactly the gesture a turned map
  is for.

- **The map turns 45°.** A contact map is symmetric about its diagonal and the
  diagonal is where all the signal is, so a square map spends most of its area on
  empty corners and draws the part anybody reads as a thin band across the
  middle. Turned, that band is the whole picture: a domain is a triangle standing
  on the axis, a loop is a dot at the height of its own span, and the x axis
  becomes genomic position — the same axis a track is drawn against, so a profile
  under the map lines up with the *picture* rather than with one edge of it. A
  true rotation, so a base pair up the side is the same length as one along the
  bottom and the plot can be measured with one ruler; a half-bin lattice, each
  source cell filling two adjacent columns, so what the renderer gets is an
  ordinary uniform matrix and pan, zoom, pooling, clip, colourbar and export are
  the code they always were. Offered only where the block has a diagonal — one
  sequence against itself, at bin level — and greyed rather than hidden where it
  does not, so the answer to "can this viewer do that" is *yes, from a map*.
  Shared by a whole deck, like the derivations, because a bar claiming one
  navigation over a band and four squares is not a comparison.

- **A ruler up the side of a turned map, in distance.** The axis that is the
  whole reason to turn the picture was the one axis with no numbers on it: the
  row ruler was switched off under a turn, since labelling a distance with
  coordinates would name places that are not there. It is the same affine line
  and the same 1–2–5 ladder as every other ruler, with a negative gradient —
  separation grows towards the top of the picture while a row index grows towards
  the bottom. The tick *spacing* could not be shared: the default is the width of
  a base-pair label, and a band a hundred pixels tall fits one tick at it.

- **A turned map is a rectangle of a size you choose, and the zoom fills it.**
  Drag the top edge for its height and either end for its width; neither moves
  when the map is zoomed. What the zoom changes is what is *inside* the box —
  more or less genome across, more or less distance up — which is also the honest
  reading, since a shorter stretch of genome has shorter distances above it.
  Fitted like any other matrix, as it was at first, a band's height was `depth ×
  zoom` and zooming in grew it until it filled the panel: at which point the
  picture is a square map again with the far corners the turn exists to throw
  away back on screen. The box opens at a third of its own width — enough band
  for a domain to be a triangle rather than a smear, short enough that the
  picture still reads as one strip along the genome; both ends widen it about its
  middle, so the edge under the pointer stays under it; arrow keys move an edge
  by a tenth of the box, Shift by a half, and a double-click puts the default
  back. What bounds it is the room the *panel* has, measured against the panel
  and not against the grid the box sits in — that grid is sized by its contents,
  so a ceiling read from there follows the box down, and every drag inwards
  lowered the limit to wherever the edge had just got to: the width could be
  given away and never taken back. The map and its tracks are centred as a group
  in the room a square map would have taken, so flipping does not resize the
  panel and a track added below re-centres the map above it.

- **The guides on a turned map are a pair of rays, not a cross.** Hold one end of
  a contact still and let the separation grow and the contact walks *diagonally*
  across the picture, so the lines that say which two places this is leave the
  pointer at 45°: a pointer on the map gets an X centred on the contact, which
  near the axis reads as a V and near the top of the band as a ∧, because the
  band is all that fits of one. A pointer on a track gets a V standing on the
  axis under it — the reader is naming one place, and the contacts that place is
  in are the two rays leaving it, both ways along the genome. And a pointer on
  the map now puts *two* hairlines in every track, one under each end of the
  contact: the column it is over is the midpoint of the two, and no track has
  anything at it. On the diagonal the two ends are one place and there is one
  line.

- **Marks on a turned map, placed by the loci they name.** Every overlay used to
  bail out where there was no row axis, so a reader's own marks vanished when they
  pressed the toggle and came back when they pressed it again. A line stays a line
  at the same place on the genome, joining up with the same line in the lane below
  it — including one drawn as horizontal, whose axis is gone but whose locus is
  not. A domain becomes a triangle standing on the axis, a loop one dot at the
  height of its own span, an arrowhead a glyph standing over that dot with its tip
  pointing back at it. A call further out than the band shows is not drawn at all:
  that is outside the data, not off the edge of the picture.

- **Every track in one stack below a turned map**, whichever edge it was put on,
  and once even if it was on two. A presentation of the placement rather than a
  rewrite of it, so everything is back where it came from the moment the turn is
  switched off — a track that returned on the bottom edge because it happened to
  be turned when the button was pressed would be the picture editing the reader's
  settings behind them.

- **A track goes on any edge of any map in a deck**, from one list. A track is
  the import and the style true of it everywhere; a lane is one placement of it,
  carrying four edge booleans and almost nothing else. A lane given no patch of
  its own cannot drift from its track, which is what makes *put it on every map*
  different from *copy it* — recolour the row and every copy moves. One press
  sends a track to every map at the edges it is already on, and one takes it off
  all of them while leaving it in the list, with its settings, ready to put back.

- **The session's heading leaves the deck's first cell.** The title, the locus
  box, the back link and the block summary answer *what am I looking at*, which
  is one question however many pictures are on screen, so a deck hoists them
  above its grid — and cell 0 becomes a cell like the others, holding a map and
  its file name. Inside, they made the first cell a head taller than the rest
  and the first map was drawn smaller than the maps it was there to be compared
  with. The deck's count rides on the end of that summary now, `113 × 113 bins ·
  … · 3 maps`, rather than in a bar of controls.

- **A deck's bar holds only what is shared**: the master chain, one scale for
  all, how many maps across, and one figure of the whole deck at 300 dpi. Adding
  a map is the `+` on an edge and rearranging is the grip, so neither is a button
  there — a bar that repeats what the pictures already offer is a second place to
  look for the same thing.

- **Maps are rearranged by dragging them.** Every companion has a grip before its
  name; taking hold of one shows the deck's tiling, and dropping a map on a cell
  exchanges the two. `◀` `▶` could only ever say *one place along a list*, which
  describes a 2 × 2 poorly: moving the bottom-left map to the top-right was three
  presses, each shuffling everything in between. The lead has a name like every
  other cell and no grip — the first map is always the lead.

- **A companion's scale controls are on its picture**, in a menu that opens
  upward from a button in the map's bottom-left corner: the score, the baseline,
  the transform, the ramp and the clip, and nothing else. What was there was a
  `colour and export` fold *under* the map, which pushed every other panel of the
  deck down by the height of whatever was open in it.

- - **A deck is drawn before it is filled** (§16.9). A `+` down the right-hand edge
  of the map and another along the bottom. Pressing one opens a *cell* rather
  than a map: what comes back is the arrangement asked for, with the reader's own
  map in the first of it and every other cell standing empty as its own drop
  target. Drop a cooler on one, click it to choose a file, or type a URL in the
  bar — in any order, or never.

  This is the feature's first entry point a reader can find. The first companion
  used to be reachable only through the command palette, so nothing on screen
  said the viewer could put several maps side by side at all — and the one
  gesture anybody would try, dropping a second cooler on the map, means *load a
  track* here.

  **Cells before maps** is the design and not an ordering. Adding maps one at a
  time makes the arrangement a consequence of the order the files arrived in, and
  the arrangement is exactly what somebody assembling a figure is composing: two
  conditions across and two timepoints down is a statement about an experiment,
  and reaching it by dropping four files into a row and then pressing `◀` twice
  is repairing a layout rather than drawing one.

  The shape is a rectangle filled in reading order, and a press adds a whole edge
  — a column beside, a row below. One extra cell on the right of a two-row grid
  cannot be expressed without pushing every map after it one place along, and a
  press must never move a map that has already been placed. The column count a
  `+` sets overrides the three layout presets, because the two answer different
  questions and a deck that reflowed into a row the moment a map was closed would
  not be an arrangement at all.

  An empty cell is a real cell: it takes a slot in `maps`, travels through a link
  as the same `~` a local companion uses, counts towards the six-panel ceiling,
  and moves and closes like any other. It does *not* count towards the memory
  budget — an empty card has no worker and no block, and dividing the allowance
  by it would read the two maps of a 2 × 2 deck at a quarter each while half went
  to rectangles. A file dropped on an edge opens the cell that edge names and
  fills it in one movement.

  Adding the column is a *splice* and not an append, one cell into the end of
  each row. The grid is one flat list in `repeat(n, …)`, so a cell's position is
  derived from its index and the column count and raising the count re-maps
  every index at once — appending turns a 2 × 2 into a three-wide row with the
  fourth map stranded underneath, which is precisely the rearrangement the whole
  gesture exists to avoid.

- **N maps side by side, navigating together** (§16). Several contact maps on
  screen at once, each with its own file, its own reader worker and its own
  colour scale, all showing the same place. Addable, removable, reorderable,
  laid out as a row, a column or a near-square grid, and carried in one hash key
  so a deck of four remote files is a link.

  The viewer already had two answers to "two files" and this is a third because
  neither generalises. A **tab** is a whole second session and only one is on
  screen, so it answers *open* rather than *compare*. The **lower-left triangle**
  is two files in one square, which is the strongest comparison available and is
  why it is gated on a matching bin size and a matching chromosome list. Both are
  untouched, and a session may hold a blended square *and* a deck: they are
  different claims about the files, and both can be true of one screen.

  **The view is shared and the presentation is not.** Which region, which level,
  which score, which balancing — that is what is being looked at, and four files
  at four regions are four unrelated pictures that happen to be adjacent. The
  clip is per panel and has to be: `vmax` is a number of contacts, and two
  libraries at different depths do not have the same one, so one clip across a
  deck draws the shallower file as an empty rectangle. **One scale** is offered
  for the case where the reader knows the files are comparable, off by default
  because it is the stronger claim — the same argument the two-file split settles
  with *match depth*, reached from the other side.

  **The lock's currency is base pairs, not matrix cells**, and that is the whole
  of why panels can be locked where triangles cannot. A 1 kb file and a 5 kb file
  both answer `chrI:20,000-80,000` and the answers are 60 cells and 12; a lock in
  cells moves the coarse panel five times too far and would have to be gated on a
  matching bin size, which is exactly the refusal side-by-side panels do not need.
  Conversion rounds outward, so a coarse panel shows at least what was asked for
  and never less; and a window running off the end of a shorter block is slid
  back inside it keeping its span, rather than truncated to the overlap, because
  answering a 40 kb view with a one-bin view is a different zoom in a deck whose
  whole promise is that the panels show the same thing.

  There is one owner and panels never speak to each other: with N panels each
  echoing to N−1 others there are N² conversations and no frame in which the deck
  is in one state. The feedback loop is guarded three ways, because an echo has
  three shapes — the synchronous one, the one frame later from a panel that had
  to slide (which otherwise makes "pan past the end of the short one" mean "you
  cannot pan past the end of the short one"), and the one that arrives later at
  the same window seen through a coarser grid. Without the last, a
  two-resolution deck drifts a cell per frame until it hits a wall.

  **A companion is asked for its block by name**, so a file that has no `chrI` is
  refused by `parse_metacooler_range`'s own error listing its own sequences. The
  one gate that does exist compares the *blocks* rather than the files: two panels
  that resolved one name to spans of different length resolved it against
  different sequences, and one window would be two places. A panel the gate
  refuses is still drawn, still readable and still exportable — only the lock is
  off, and it says so in a line under its own heading rather than only in a
  tooltip on a 14 px chain, because a still map reads as data.

  **A local map keeps its slot in a link.** `uri2` omits a local second file,
  which is right when there is one slot; with several, omission moves everything
  after it one place left and a deck of three arrives as a deck of two with
  nothing saying a map is missing. It is written as `~`, and the recipient gets a
  drop rectangle where the sender's file was. The separator is `|` rather than the
  comma the other lists use: a comma is legal in a URI, so `maps=a,b` would
  resolve — to two maps that are neither of the ones that were sent — the first
  time somebody published `sample,rep1.cool`.

  **N panels cannot silently blow the memory budget.** `checkBrowserDenseSize` was
  written for one block and has no idea how many are about to be live, so the
  deck divides one panel's allowance between all of them: a deck can never cost
  more than the single map it replaced, and every map added shrinks every panel's
  share, which is what refuses an over-large deck by arithmetic rather than by a
  guessed limit. Six panels is the ceiling above that, for the reason twelve
  sessions is one.

  The three side panels are untouched. The deck's controls ride above its own
  grid and each panel's colour and export cards ride inside that panel, which is
  both the plainest statement of what is shared and what is not, and the only
  placement that works on a file with a genome layer — where the Annotations
  column does not exist at all (§8.5), and which is exactly the kind of file a
  deck is most useful for.

- **Values the file does not contain.** A cooler stores counts and, if somebody
  ran `cooler balance`, one weight per bin. Everything a reader wants beyond that
  is arithmetic over numbers already on screen, and none of it needs a companion
  file, a preprocessing step or a server — so the constraints that shape this
  viewer permit all of it.

  **Normalisation** joins the score picker: `VC`, `VC √` and `ICE`, computed from
  the block. They are in that list rather than beside it because a reader
  choosing between `balanced` and `ICE` is choosing between two answers to one
  question — whose balancing, the file's or ours — and because `balanced` is only
  offered on a file somebody balanced, so a reader of an ordinary file previously
  had one entry, no control drawn at all, and no answer to "can I see this
  normalised".

  **Observed over expected** gets a toggle of its own, because it answers
  "compared to what" rather than "what number is in the cell", and it composes
  with every entry in that list — `O/E` of balanced counts is the standard
  reading, and folding it into the same dropdown would have made the two mutually
  exclusive for no reason but the shape of the control. Contact frequency falls
  by two to three orders of magnitude from the diagonal outwards; that decay is
  the strongest signal in any Hi-C map and the one nobody is looking for, and
  dividing it out is what makes the departures from it the picture.

  **The comparison becomes a three-way**: `split`, `ratio`, `difference`. The
  split answers "what do these two look like"; past a certain similarity the eye
  cannot get "where do they differ" out of two triangles at all, and the other
  two draw that directly, with every cell where the files agree at the neutral
  colour. Depth matching is forced on for both and its checkbox hidden — a ratio
  of two libraries at different depth *is* that scalar everywhere, a flat wash
  with the structure invisible, so there the depth is a nuisance parameter with
  no reading rather than a choice worth offering.

  Juicer's `KR` is deliberately not a fourth normalisation. It and iterative
  correction solve the same problem and converge to the same weights; KR is a
  faster solver for it, and at this scale the fixed point converges in
  milliseconds, so it would buy a name in a menu and nothing anyone could see. A
  file balanced with `KR` elsewhere and read here under `ICE` shows the same map.

- **A colour scale that can express a middle.** A ratio is not a quantity with a
  bright end but one with a neutral point, and three things had to change
  together for that to be drawable — doing fewer would have produced a plausible
  picture of the wrong thing. `log2` joins the transform list, so twice and half
  sit the same distance either side of neutral; the auto range becomes symmetric
  about it, so the colour meaning "these agree" is the middle of the ramp rather
  than an arbitrary point in it; and `RdBu_r` is the first diverging colormap,
  red for more. The panel takes the transform, the colormap and the clip when a
  derivation is switched on and gives all three back when it is switched off,
  because a `vmax` of 8 is a sensible ceiling on `log1p` counts and nonsense on
  `log2` of a ratio.

  Pooling changed with them. A contact map is pooled by its brightest cell,
  because its signal *is* the bright cell; a ratio pooled that way shows only the
  arm above neutral, so every region where the second file is the stronger one
  would have vanished at fit zoom — half of what a difference map is for.

- **One lane made out of two.** The same three operations for the tracks: a
  ratio, a log ratio or a difference of two bigWigs, from the batch bar when the
  selection is a pair. Two profiles drawn as two lanes are read by eye, one
  against the other, and the eye is bad at it — a small consistent difference is
  invisible under the large shared shape.

  Combined on the **common refinement** of the two interval lists rather than on
  a grid. Two bigWigs' intervals do not line up, and evaluating both onto a
  uniform grid is one line and wrong exactly where it matters: a boundary falling
  inside a cell is smeared across it, so a sharp edge in a control track becomes
  a ramp and the ratio against it develops a spike at the position being asked
  about. Cutting at every boundary of either input is exact and costs at most as
  many intervals as the two inputs together. A derived lane fetches nothing of
  its own — both operands go through the ordinary sample cache — so it inherits
  the pan-and-zoom-free rule from the two it is made of, and removing an operand
  takes it with them.

- **Each companion picks its own resolution, from the `::1000` beside its name.**
  A deck lands an `.mcool` on the lead's bin size (§3.4), which is the right
  guess and only a guess: two files rarely have the same ladder, and the rung
  that makes a comparison legible is not always the one that matches a number.
  The entry is a picker now rather than a fact — the same control the breadcrumb
  gives the session's own file, in the only place a companion has for one, which
  is its heading. The choice is written into that panel's own address, so it
  survives every navigation, every change of chromosome and the link: the map
  reopens at the rung the reader chose, not at the one the deck guessed. Hidden
  on a plain cooler and on a one-rung collection, where the control could not be
  used.

- **A deck closes from its own bar**, with the × at the right-hand end of it —
  and it takes the tracks that were only there for the companions with it. A
  bigWig dropped on a companion's edge is an import into the session's one track
  list, so closing the maps it was drawn on used to leave it loaded, invisible,
  and holding a row that said it was drawn nowhere. A track that is *also* on
  the first map is a different thing — it is being read against a picture that is
  staying — so it keeps its lane there and loses only the companions'. Nothing
  touches the first map, which is the session's own view: closing the deck leaves
  exactly what closing the last companion one at a time would.

- **⌘C copies the whole deck**, laid out as it is on screen, at the same 300 dpi
  the deck's save uses. The key meant "copy the figure" and copied the lead —
  one cell out of six, on a screen showing six, which is the answer to a question
  nobody asked. There is only ever one picture in front of the reader, so there
  is one command: with a deck up it is the deck, and without one it is the map it
  always was.

- **Analysis, in the browser.** A fourth panel, outermost on the right (`j`), lists what can be
  computed from what is open, and clicking a row opens a drawer to run it in.
  Fourteen tasks: contact probability P(s) with its log–log slope, coverage and
  marginals, diamond insulation with boundary calls, a virtual 4C profile,
  compartments with their correlation matrix, eigenvectors and saddle, metaplots
  over feature sets, aggregate peak analysis, chromosome interaction domains,
  a track correlation matrix, interval-set overlap and Jaccard, and four that
  only a metagenome has — per-MAG contact QC, contig purity and contamination
  calls, split-MAG detection, and the inter-MAG contact network.

  Everything about them is a parameter, because the useful version of any of
  these is the one run three ways: insulation over a doubling ladder of window
  widths rather than one, an APA normalised against distance-matched shifted
  controls *or* against observed/expected *or* not at all, a metaplot in fixed
  windows or over scaled regions, a 4C anchor with cis-only or trans included.
  Every parameter is one entry in a task's descriptor, and one renderer draws
  them all — a new task is a descriptor and a function, not a form.

  What it is *not* is a modal. The drawer is a peer of the map: it takes width
  from it rather than covering it, drags to any width you like, and the map keeps
  drawing at that width. A plot you are reading and the region it came from are
  worth having on screen together.

- **A job never blocks the view.** The analysis runs in a fourth worker with a
  mount of its own, so a whole-file scan over tens of millions of pixels — P(s)
  on a 26 MB MetaTOR output, say — leaves pan, zoom and navigation exactly as
  responsive as they were. The reader worker is not asked for anything while a
  job is running, and a job started from one view survives moving to another:
  the **framing is an input, captured when you press the button**, and is
  reported back in the result's provenance rather than tracking wherever you
  wandered to since. Progress and cancel are on every scan, the same way §7.3's
  overview has always had them.

- **The panel shows the whole catalogue, and says what each task is waiting
  for.** A task used to vanish when its input was not loaded — APA with no loop
  set, the metaplot with no bigWig — on the argument that a disabled row is a
  promise the file cannot keep. That argument is right about a metagenome task on
  a plain cooler, where nothing the reader does next produces a `/genomes` table.
  It is wrong about a task that is one drag-and-drop away: hiding APA does not
  spare anybody a broken promise, it teaches them the application does not do
  aggregate peak analysis.

  So there are three answers now instead of two. **Absent** where nothing the
  reader can do would help. **Waiting** — listed, dimmed, with a line saying what
  to load — where something would. **Ready**. A greyed row carrying an
  instruction is not an unkept promise; it is the menu.

- **The Analysis panel exists without a contact map.** Metaplot, track
  correlation and interval overlap read only the loaded tracks, and a 1D browser
  session is exactly where a reader has the tracks and not the matrix — so the
  column was being taken away from the people who could use three of its tasks.
  There the map tasks are greyed on *open a contact map*, the track tasks run,
  the analysis worker is never mounted because nothing asks it for a pixel, and a
  result's provenance names the assembly rather than a block.

- **A 4C anchor is picked on the map.** Reading coordinates off a picture in order
  to type them back in beside it is asking twice, so the Anchor box carries a
  **Pick on map** button: press it, Shift-drag along either axis, and the box
  fills. An *arm* rather than a mode left on — one drag answers it and the button
  goes out, so a reader who wanted one anchor does not find their next three
  attempts to zoom quietly redefining it. Escape is the way out, and it works from
  wherever the focus happens to be, since the button that armed it is across the
  window from the plot.

  What is written into the parameter is the resolved locus, never a "from the map"
  sentinel — so the record of a run names the place it was a reading of, which is
  the whole of what the provenance is for. The box stays editable throughout: a
  picked locus is a starting point for a typed correction rather than a
  replacement for one.

- **Results come back as tracks.** A task that produces one value per bin —
  insulation, 4C, coverage, an eigenvector — lands in the Annotations panel as a
  **synthetic track**, and from there it is indistinguishable from a bigWig you
  loaded: it has a colour chip, an editable range, autoscale, a height, a place
  in the stack, a group, and it can be dragged to any of the four edges. It is
  the same store and the same renderer, so nothing about lanes had to learn what
  a computed track is.

  A task that produces *intervals* — insulation's boundaries, CID's domains —
  lands there too, as an **overlay** on the map it was called from, with the same
  colour, shape and opacity controls any dropped BED gets. Running the task again
  replaces that row rather than adding another, because the second run is the one
  you wanted. And it exports as **BED** (or BEDPE for a paired set), through the
  same writer the hand-drawn marks use — one opinion about half-open ends in this
  repository, not two — so a called boundary set goes into bedtools, into IGV, and
  back into this app as an overlay. That last is the property the test asserts;
  the text is only how it gets there.

- **A bigWig writer, in this repository.** Header, zoom levels, total summary,
  chromosome B+ tree, data sections and R-tree index, written byte by byte, with
  `CompressionStream('deflate')` doing the zlib framing the format wants — no
  dependency, no `bedGraphToBigWig` step, no server. Any per-bin result exports
  as a bigWig that IGV, deepTools and pyBigWig open, and the ones that are not
  per-bin export as bedGraph, BED, or TSV. Plots export as PNG and as **true
  vector PDF**, through the same `VectorPage` the 1D browser has used since 0.6.

  Its tests read every file back with `@gmod/bbi` — the same library the app
  reads other people's bigWigs with — and then walk the B+ tree byte by byte at
  depth 3, because no reader in existence compares an internal node's keys
  against its subtree and a wrong key is invisible until somebody else's tool
  opens the file.

- **Compartments can be phased by GC content**, not only by a gene model. Which
  end of an eigenvector is "A" is arbitrary until something outside the matrix
  decides, and a FASTA is the signal available when no annotation is — so
  choosing one now fixes the sign, and the drawer says which signal did it and
  how convincingly.

  How it gets there is the interesting part. The residues live in the
  annotations worker and are megabytes; the task runs in the analysis worker.
  Rather than give one parameter a third venue, the main thread asks the
  annotations worker for a *sample* at the file's own bin size — the same
  request its GC lane is already drawn from — and ships one number per bin with
  the job. `run/compartments.ts` never learns a FASTA was involved. The same
  path resolves a chosen bigWig, which had been declared since the first
  milestone and never implemented.

- **`coolwarm`**, matplotlib's diverging blue–white–red, for the signed things:
  an eigenvector, a log ratio, an observed/expected matrix. Deliberately *not*
  added to the colour-vision-safe list — a diverging red/blue ramp is exactly
  what deuteranopia collapses, and the picker should keep saying so.

- **Goldens for the analysis, against four other tools.** Eight of them, built by
  `npm run fixtures:analysis` from the demo micro-C map with **cooltools**,
  **coolpuppy**, **pyBigWig** and **numpy**, and committed. Each carries two
  oracles: this repo's own definition recomputed in numpy, compared to equality,
  and the other tool's number under *its* definition, compared to whatever
  relation actually holds.

  Three of those relations turned out to be exact and are asserted as such. P(s)
  equals `expected_cis` cell for cell. Coverage satisfies
  `cooltools_cis == ours + diagonal` — cooltools sums the pixel table by both
  ends so a diagonal pixel counts twice, and this repo counts it once on purpose,
  which the identity now proves rather than asserts. APA equals coolpuppy's
  pileup once the loops whose window would cross the main diagonal are left out.

  **Insulation is not one of them**, and that is recorded rather than smoothed
  over: cooltools' diamond is offset by a row, drops two diagonals, divides by a
  count instead of summing, normalises by a median instead of a mean, and masks
  near dropped bins. Both definitions are published; what is left between them is
  a correlation of 0.61–0.85 on budding yeast at 1 kb, which has little domain
  structure. The golden records the measured figure per chromosome and window and
  the test asserts it has not degraded, which is a true statement where an
  equality would have been a false one.

- **`TASKS_PLAN.md`**, and **SPECS §18**. The plan is the build document; §18 is
  the specification the source cites, and it now carries the ten analysis rows of
  §12's budget table, the first of which is the one that mattered most: *any
  analysis task, effect on the view — 0 dropped frames, 0 blocked reader
  requests*.

### Changed

- **The virtual 4C lane is gone, and Shift-drag is a zoom.** Shift-dragging on a
  map used to conjure a strip beside it summing that band of the matrix. Every
  part of that the **4C task** now does better: it reads the pixel table rather
  than whatever block happened to be loaded, it produces a track with a row on a
  card and a bigWig to export, and it carries a provenance line saying what it
  is. A dimmer second copy of the same answer, appearing without being asked for
  and redrawing itself on every pan, is worth removing even when it works — and
  the two disagreed at every level but the finest.

  What replaces it is the gesture the picture was missing. **Shift-drag names a
  band of one axis and zooms to it**, on the map, on the track lanes beside it,
  and in the 1D browser — one conversion from pixels to bins behind all three, so
  a stretch dragged out next to the map is the stretch the map goes to. The axis
  follows the hand, so a drag a few degrees off vertical still means what it
  plainly meant, and the axis nobody dragged keeps its centre.

  **And every one of these gestures copies what it framed.** Shift-drag writes
  `chrIV:500001-510000`: no thousands separators, a plain hyphen, 1-based
  inclusive — the difference between a string that pastes into samtools,
  bedtools, IGV and this app's own locus boxes and one that only looks right.
  Option-drag, which selects a box, writes both axes as
  `chrI:1-10000|chrII:40001-50000`, rows then columns, each half exactly what
  that stretch would produce on its own.

  Nothing else about lanes changed, because the lane was never the point: the
  `viewpoint` kind and card are gone from the store, and the four edges, the
  drag-to-another-edge, the tooltip and the exported figure are the code they
  already were.

- A shared link carries the two new readings, because both are part of what is
  being looked at rather than how it is shaded: `oe` for the baseline and `op`
  for the comparison. The normalisation needed no key of its own — it is a
  `score`, and resolves through the same list the picker is built from, so a hash
  naming one this build cannot serve lands on counts rather than on a read that
  cannot be answered.

- Adding or closing a map no longer rebuilds the one beside it. `maps` names what
  is on screen *beside* this view, and the deck reconciles itself from it before
  the render path decides anything — so the lead has nothing to be rebuilt for.
  Left out of that list, every press of `+` cost a worker round trip and threw
  away the reader's pan and zoom for a change that happened in another panel;
  drawing a 2 × 2 deck paid it four times, and on a gated whole-genome map (§7.3)
  each one would have put the pixel scan back behind its button.

- **The turn and O/E are toggles, side by side, in one row of the Map card.** They
  are the two controls that change *what picture this is* — one the geometry, one
  the units — as against the score and the clip, which change what a number is
  worth, and the overlays, which change what is drawn over it. They were an icon
  button that looked identical before and after it had been pressed, and a
  tickbox beside it that made the same kind of setting look like a different kind
  of thing. Both are now lit the way every overlay toggle is. The turn's mark is
  **the shape it will give you** — a triangle while the map is square, a square
  once it is turned — rather than a mark for the state it is in, which is the one
  reading that needs a second glance at the picture to interpret. O/E's mark is
  the two letters, because a ratio has no shape and the nearest drawn thing is a
  division sign that would say "divide" without saying by what.

- **No drawn pointer where a guide line is already pointing.** The crosshair is
  the better instrument of the two — it is drawn at the cell the app has actually
  resolved, it runs the width and height of the picture, and it continues into
  every track — while the arrowhead beside it is a second, blunter mark for the
  same position, sitting on top of the pixel it names. So it goes, exactly where
  the line comes: on the map while the crosshair is on and the pointer is over a
  cell, in the 1D browser while it is on and the pointer is on the axis rather
  than in the name column, and on a lane stack always, since a lane answers a
  pointer with a hairline whatever the preference says. The transient cursors
  stay — the closed hand while panning, the crosshair while a selection is about
  to be drawn — because those say what is *happening*, which no guide line does.

- **The deck's bar reads from the left**, with the one control that ends the deck
  at the far right. The spacer used to sit second, which split a row of one kind
  of thing into a chain on the left and three controls floated against the
  right-hand edge — on a wide window, a screen apart, so reading the bar meant
  looking in two places and which half a control was in said nothing about what
  it did.

- **The README no longer says balancing is unavailable.** It has been built since
  0.2 — `/bins/weight`, two bounded slices for the bins on screen, `raw · wᵢ · wⱼ`,
  and a control that became the score picker in 0.9 — and the paragraph claiming
  otherwise had outlived the divergence it described by seven releases. Since
  every analysis task wants balanced input, a stale line saying it cannot be had
  was one misreading away from someone concluding these numbers are computed on
  raw counts. The layering rule above it is corrected in the same way: no
  *coordinate* ever comes from `/bins`, which is what §3.3 says and what
  `bins-guard.test.ts` proves, and the weight column is the one bounded exception.

- **"No write access" now says what it always meant.** The viewer has produced
  files since 0.2 — PNG and PDF, then a saved session, then a BED of hand-drawn
  marks in 0.5 — and a bigWig is one more of them: new bytes handed to the
  browser as a download, needing no server, touching nothing that was opened. The
  non-feature is *editing an input*, never *authoring an output*, and SPECS §13
  says so now rather than leaving a reader to reconcile the two. Which is also
  why there is still no writing of `.cool`, `.mcool` or `.metacool` — h5wasm
  could create one, so that is a decision and not a limitation.

### Fixed

- **A track turned off stays off when the resolution changes.** Whether a row is
  drawn is a setting like its colour and its height, and it was the one that did
  not come back: the door a row returns through is the same one a new row arrives
  by, and a new row is drawn. On an `.mcool` that is not a rare event — the same
  file at another resolution is a fresh open with the tracks restored around it —
  so changing the resolution quietly undid a reader's "not this one", by way of a
  menu about something else entirely.

- **The 1D browser's ruler gains digits as it is zoomed.** Two decimals of a
  megabase is ten kilobases, so a window narrower than that on a chromosome
  measured in megabases wrote the same number under every tick — an axis reading
  `4.60 Mb` four times over, under a picture zoomed in to answer exactly the
  question it was there for. The ruler now passes the gap between its own ticks
  to the formatter, which picks a unit two decimals can tell them apart in and
  steps down rather than growing a third: `4.6 Mb`, `4605 kb`, `4601520 bp`. The
  map's own rulers go through the same call and gain the same digits.

- **A derivation over a turned map is drawn at the depth the band has.** Turning
  a map and then switching on O/E painted the near-diagonal half of the band a
  solid navy block. The band is re-cut behind the picture as the zoom moves, so
  it is not always as deep as the box would cut it now — and a derivation is
  swapped in as *new numbers in the same grid*, so one computed at the box's
  depth arrived at a grid of another and was read with the wrong stride: every
  row a different separation from the one it was drawn at, and a tail of memory
  nothing wrote beneath them, which colours as a solid block of the scale's
  floor. The swap now asks for the grid that is there, and the renderer treats a
  length that does not fit as the reshape it is rather than drawing it.

- **Zooming a turned map is a zoom again, not a stall.** On a whole chromosome
  at a fine resolution every wheel notch blocked the main thread for about a
  second: twelve notches drew 48 frames, twelve of them over 50 ms and the worst
  over 1.3 s. Three things, in order of what they cost. The **colour scale** was
  re-measured on every re-cut — a pooling and a percentile selection over the
  whole square block, four fifths of the total, spent proving the colours were
  the colours they already were; the block a band is cut from does not change
  when the cut does, so the measurement now survives the reshape. The band is
  re-cut **only when it is too shallow**, since a band deeper than the box is the
  same picture — it stands on the box's floor either way and the extra rows are
  clipped off the top — so zooming *in* costs nothing at all; and when it is too
  shallow it is cut twice as deep as asked, so a zoom out is one rotation rather
  than one per notch. And the rotation itself no longer blanks the whole band
  before filling it: only the two corner triangles are empty, so the pass that
  emptied them is over those instead of over the largest array a turned map
  allocates. The same twelve notches now draw 229 frames, none of them over
  50 ms, and zooming back out is the same.

- **A turned band keeps its size across a navigation.** The box was a field on
  the panel, and the panel is rebuilt on every navigation — so a change of
  resolution, a click on another chromosome or a zoom into a region put the band
  back at its default, which is to say the reader lost it the first time they
  went to look at something in it. It is a store now, like the 4C anchor and for
  the same reason, shared by every map of a deck and remembered between sessions.
  What is stored is what the hand dragged; each panel fits it to the room it has
  on the way out, so a box shaped beside a wide map is still the box beside a
  narrow one and a window made small and wide again comes back to the size the
  reader chose.

- **There is a pointer again where the guide lines are.** Hiding the hardware
  pointer entirely left nothing to follow between frames — the lines are at the
  position the app has *resolved*, and the hand is somewhere they have not got to
  yet. It is a small open cross now: four short arms around a hole, so the pixel
  it is about stays visible through the middle, and drawn a little heavier than
  the hairlines it stands among, since a pointer that reads as one of the guides
  is a pointer that has to be hunted for. The arrowhead is still the resting
  cursor everywhere the guides are off, and the transient cursors are untouched.

- **A turned map's ruler is measured in the same place as its readout.** The
  column axis under a turn counts in half bins, and the halving was applied to
  where the *block starts* as well as to the step — so the ruler sat half of the
  block's own offset into the contig behind the picture drawn on it. On a window
  opening 120 bins into a chromosome every tick read 60 kb short, and the tooltip
  disagreed with the axis beneath the very cell it was describing. Only the step
  is a cell size; where the block starts is a distance in whole bins, as it is for
  everything else that reads it.

- **The top edge of a turned band follows the hand that drags it.** Screen y grows
  downward and the box does not, so dragging the top edge towards the top of the
  panel — which is the whole gesture for "taller" — made the band shorter.

- **The maps in a deck line up again when they carry different tracks.** The room
  a stack takes was reserved from the *lead's* geometry, on companions assumed to
  have none of their own — so a strip above one map and none above another drew
  the same window at two heights. Every panel now leaves room for the deepest
  stack on each edge across the whole deck and pads out the difference. Asked of
  every panel at the moment it is used, not accumulated as they report: they
  announce in whatever order they finish reading, and a running maximum is a
  maximum over whoever has spoken so far, which on the first pass reserved
  nothing at all.

- **The location control reads.** A label column and four edge buttons cannot
  share a sidebar row, so `bottom` came out as `bottc` — the single thing the
  segmented control was laid out to avoid — and beside a deck both map names came
  out as the shared `Ecoli.mcool…` prefix, truncated at exactly the point where
  they stop being the same file. The field turns on its side.

- **A deck survives the navigations of the file it is beside.** Every navigation
  builds a fresh state, which is right for the region and the level and wrong for
  the two keys that name what is on screen *beside* the view — so clicking
  Chromosomes and then a contig came back with the deck gone and its workers
  released. `maps` and `uri2` are now carried across a navigation within one
  file, by path, so changing the resolution keeps the deck and opening a
  different file does not.

- **An `.mcool` can be a companion.** A collection is not a map at its root, so
  it opened as an error about `::` syntax the reader never typed, in the
  rectangle where their map should have been. A companion now descends into an
  entry the way the compare card and the picker already do, preferring the lead's
  bin size, and publishes what it opened so the link names the map rather than
  the collection.

- **A companion knows it is balanced.** Under `log10` a balanced cell is
  negative, and the automatic range keeps negatives only when it is told the
  matrix is balanced — so a companion built without the flag drew a blank
  rectangle from a range of `[0, ~0]` over data that was perfectly good, with a
  key calling the numbers counts. The score's own resolution had the same shape
  of bug one level up: read straight from the state it answered `count` for a
  map whose picker said `balanced`, because the default is a fact about the file
  and is nowhere in the hash.

- **A new companion opens on the lead's score and clip.** The score is shared as
  a *resolved* choice rather than as the hash key that named it: a balanced file
  opens balanced and that default is nowhere in the URL, so two panels each
  applying their own put a balanced lead beside a companion drawing raw counts.
  A panel that has to fall back to counts — no weight column — keeps the ramp and
  finds its own bounds, since a clip measured in balanced units would draw it
  black.

- **The maps in a deck line up to the pixel, tracks or no tracks.** The room the
  lead's lane stacks take is reserved on every panel beside it and every picture
  is pushed to the foot of its cell, so a map inset by a stack no longer stands
  beside one that is not.

- **The `+` along the bottom of a map is above the fold.** It comes out of the
  plot's own vertical budget now; on a map sized to the window it needed a scroll
  to reach, which is a poor place for the one gesture that says this viewer can
  show two maps.

- **The 45° turn reaches every map in a deck.** A companion was never handed the
  setting, so flipping a deck put the lead on its diagonal and left the maps
  beside it square — under a bar still saying one navigation. The turn joins the
  derivations as something the deck shares and a companion applies without
  offering a second copy of the control.

- **The turn's own control is a switch rather than a latch.** It read whether the
  map was turned from the presentation object captured when the panel was built,
  and the session replaces that object on every render — so the button asked for
  a flip that was already on, could never ask for it to come off, and never lit
  up to say the map was turned.

- **Two turned maps in a deck show the same window.** The navigation lock was
  told the square block's bin size and column count while being reported the
  turned band's window. A rotated cell is half a bin and the band is `2n − 1`
  columns wide, so a whole-band view came back as twice the base pairs it covers
  and was clamped to half the columns at the other end: every turned panel drew
  half of what the panel beside it was drawing.

- **A cooler dropped on a deck's empty cell is not also imported.** The content
  area's own file handler took the same drop, so one gesture opened the companion
  the reader aimed at *and* loaded the file over the lead. The deck's cells and
  its `+` edges now answer for themselves, as the landing page's drop zone and
  the map's lane edges already did — and the exemption is tested with
  `instanceof Element` rather than `HTMLElement`, since an inline `<svg>` is
  neither, and the `+` glyph is the most obvious pixel on an edge to aim at.

- **A refusal to lock a turned deck says what is actually wrong with it.** Two
  files at different resolutions turn to different depths, because the depth is
  a fraction of each block rounded to a whole bin — a real reason not to share a
  row window, and nothing to do with the sequences. The panel used to borrow the
  wording for two files that resolved one name against different sequences,
  which is a claim a reader may act on.

- **A view mounted without the `+` edges is no longer pinned by them.** The
  session keeps one frame for its whole life and it holds the last view it
  framed, so opening a genomes table left a destroyed heatmap's canvas
  referenced until the reader navigated back to a map.

- **A turned band stands on the tracks it is read against.** A band is a fraction
  of the block deep and twice it wide, so at anything short of a close zoom it
  fitted the panel's height several times over — and it was centred there, which
  is the square map's rule and the wrong one here: a rectangle floating half way
  up its panel with a stripe of paper between its diagonal and the profiles the
  whole turn exists to line it up with. A band now fills the box it is drawn in
  (see the box, above), so its diagonal is on that box's own floor at every zoom
  — the ceiling for the mirrored half of a comparison — and there is no vertical
  pan to lose it with, a band dragged off its own diagonal having lost the axis
  it is measured from.

- **The tooltip's coordinates on a turned map.** The two sequence names and the
  distance were mapped back through the rotation and the pair of positions under
  them was not, so the card named the right sequence, the right separation, and a
  pair of coordinates belonging to neither: a turned cell's row is a *separation*
  and its column is half a bin, and read as block indices they land half way
  along the picture. Clicking a cell went the same way, and now goes through the
  same inverse.

- **Both drags on a turned map.** Up the side of a band is distance from the
  diagonal, which bounds no window — so a marquee committed a box over rows the
  block does not have, and a mostly-vertical 4C drag asked for a band of
  separations and resolved to nothing at all, silently, because the axis it named
  is `null` under a turn. Both gestures now use the axis that has coordinates,
  which is the only honest reading left. A selection is a full-height band over a
  stretch of the genome and opens the square it cuts out — the on-diagonal
  window, without the reader having to hold anything down for it — and a 4C drag
  names that stretch however the hand travelled. The diagonal lock goes with
  them: on a turned map the diagonal is the bottom edge of the picture, so
  snapping a corner to it would be snapping to the frame.

- **Turning the map no longer changes its colours.** The automatic range is a
  property of the block that was read — that is already the rule for a square
  map, where neither a pan nor a zoom re-measures it — and a band broke it by
  being a *crop*: it keeps the near-diagonal separations and drops the rest, and
  the ones it drops are where the extremes live. On an O/E map the effect was
  dramatic, the range being the 99th percentile of the departure from neutral and
  the far separations being where a small count over a small expectation produces
  the largest departures there are: turning the map roughly halved its range, and
  dragging the depth handle moved it again on every pixel. The band is now scaled
  by the block it was cut from, so the turn is what it claims to be — a change of
  geometry and nothing else. (Not, as it looks, the square counting both of its
  triangles: a percentile does not care how many times each value appears, so
  that costs nothing and there was nothing to halve. And §7.1 pins the square's
  rule to `metacooler show`'s to the bit, so the two could only ever be made to
  agree in this direction.)

- **The O/E reading in the tooltip on a turned map.** It indexed the band with
  the square's row stride, so the multiple under the pointer was a real number
  from a real cell and not from the cell being pointed at.

- **O/E leaves an unobserved cell as paper.** Zero over anything is zero, and on
  a scale centred at 1 that is the far end of the ramp — so an O/E map of a
  sparse block came out as a wall of "maximally depleted" over every empty pixel,
  which is the loudest possible statement of the one thing the file does not say.
  Nothing seen is what paper means on every other map this viewer draws. An
  infinite ratio goes the same way, being a fact about a baseline too small to
  divide by rather than a measurement; a negative one stays, because an extra
  `/pixels` column may legitimately hold negative numbers and blanking those
  would be this rule deciding what a file is allowed to contain.

## [0.9.0] - 2026-08-07

### Added

- **Four edges, and a 4C profile that is a lane on any of them.** A track can be
  drawn above the map and down its left side as well as below it and beside it,
  and the four stacks are peers: the same drop rectangles, the same handle to
  reorder or move a lane, the same border to drag it taller, the same hairline,
  tooltip, group bars, loop anchors and exported figure. The row's **location**
  control now offers all four, and a lane's right-click menu offers them too —
  as words, beside a new item that says which way the signal grows.

  Which way it grows is the one thing that is not a coordinate, and the two axes
  answer it differently. A **horizontal** lane grows up the page wherever it is:
  every browser ever built draws coverage rising from a floor under a ruler, and
  a profile above a contact map hanging from its ceiling is one a reader has to
  mirror in their head before they can compare it with the one below. A
  **vertical** lane has no such convention, so the corner decides and it grows
  towards the matrix. Exactly one edge therefore turns a lane on arrival, which
  is what it was when there were only two — bottom and right behave exactly as
  before, and moving a lane between two edges turns it again precisely when that
  answer changes, so a reader who deliberately hung a track from its ceiling
  keeps that decision through the move.

  What made this affordable is that `render/lane.ts` is still the only module
  that knows which of *along* and *across* is x. **Across now always runs
  outward, away from the map**, which above the map and to its left is the canvas
  direction reversed — so "the far border", "the end the handle hangs off" and
  "where the baseline is" stay one answer each rather than becoming four. The two
  new stacks cost a coordinate conversion, not a second renderer.

  **The virtual 4C profile is now one of these lanes**, and that is the point of
  the change rather than a consequence of it. It was a strip of its own with a
  canvas of its own, which meant it had none of what a lane has: no name you can
  type, no limits you can type, no autoscale, no ceiling drag, no floor to drag,
  no colour, no handle, no readout, no place in the stack. It is now a synthetic
  entry in the same store every track lives in, so it has all of them, from the
  one implementation — and can be dragged to any edge like anything else.

  Moved to the left or right of the map it answers a **different question**, not a
  rotated one: a strip above or below the map sums a band of rows and answers per
  column, and a strip beside it sums a band of columns and answers per row. Same
  anchor, same block, the transpose. Off the diagonal that may have an answer on
  one axis and none on the other, and the lane says which.

  It also **marks where its anchor is on its own axis**, as a short bar — the
  same glyph a group of tracks is marked with — in a gutter it keeps clear off
  its floor, which is the one end of a lane the signal never reaches, so the mark
  sits under the line rather than in it. The band being summed is on the *other*
  axis and so is nowhere in the picture; this is the fact a reader keeps asking
  for instead, because on a map read about its diagonal it is where the
  self-contact peak ought to be. The room comes out of the lane's own height
  rather than being added to it, and it is kept whether or not an anchor is set,
  so the line does not jump under the hand that has just drawn one.

  It carries no file, so it is on no card, is never written to session storage,
  and is not drawn in the 1D browser. It is also the only lane that draws where
  there is no coordinate system at all — a contig-level or whole-genome block —
  because its numbers come from the block on screen rather than from a fetch;
  there it says, in the lane, that an anchor cannot be named at this level, which
  is a better answer than the "not in this view" it used to give and than the
  instruction for a gesture that does nothing there.

  Switching it off **hides** the lane rather than removing it, so the colour,
  height, axis and edge a reader chose survive being turned off and on — and on
  a file that carries no annotations at all the lane belongs to the *file* rather
  than to the view, so it survives opening a chromosome as well.

  The empty lane's instruction is a control and stays on screen: an exported
  figure gets the outline, so an empty strip reads as a lane with nothing in it,
  and not a sentence addressed to somebody with a map in front of them.

- **Private buckets.** **Open a file → private buckets…** takes a URL prefix, a
  region and an access key, and everything under that prefix is then read with
  a Signature Version 4 signature on every request — the map, its tracks, a
  published session in the same folder. Everything else, the public demos
  included, stays unsigned. The dialog also *browses* a prefix: one
  `ListObjectsV2` per level, folders and files as rows, click to open. That is
  the half a URL box cannot do, since nobody remembers the key of a `.mcool`
  inside `collections/hum53/2026-03-run2/`.

  The scope is a **prefix, not a bucket**, so a bucket whose `demo/` is public
  and whose `collections/` is not works as one bucket. Signing the public half
  would add a CORS preflight to every read for nothing, and would fail outright
  against a key scoped the way `docs/hosting.md` says to scope it. Matching is
  longest-prefix, so a per-project key can sit inside a general lab key.

  **The signer computes SHA-256 itself** (`src/s3/sha256.ts`) rather than using
  `crypto.subtle`, and that is a requirement rather than a preference: the
  reader's hot path is a *synchronous* `XMLHttpRequest`, because Emscripten's
  stream `read` op is synchronous, so there is no `await` between HDF5 asking
  for bytes and the request going out — and every `crypto.subtle` method returns
  a promise. Presigned URLs were the alternative and are worse here: scoped to
  one method, so the `HEAD` probe needs its own, and they expire while a tab is
  open. The hashing is checked against `node:crypto` at every length across the
  padding boundary, against AWS's published vectors, and against a second
  implementation for whole requests.

  Credentials are looked up **once, at the worker boundary**, so the dozen
  places that build a remote source — the URL box, the compare card, a resolved
  session config, a restored track row — know nothing about keys, and a key
  added mid-session applies to the next request rather than the next reload. The
  worker holds no credential store and gets only the one key the URL it was
  handed needs.

  The key is in `localStorage` and readable by any script on the origin. There
  is no arrangement in which it is not — the app has no backend by construction,
  which is the same property that makes a dropped file never leave the machine
  — so what bounds it is the key's own permissions. The dialog says so, and
  `docs/hosting.md` has the two-action IAM policy and the CORS policy a
  credentialed preflight needs.

### Changed

- **A track dragged out of the Tracks card onto an edge turns its axis**, which a
  track dragged there by the handle on its own picture has always done. The two
  gestures mean the same thing and now take the same road; the card's own
  location control has always taken it.

- **The demo datasets moved to S3, and the app got 14× lighter.** The five
  published maps and eleven track resources are no longer copied into the
  bundle out of `public/demo/`; they live on the lab bucket at
  `https://rsglab-data.s3.eu-west-3.amazonaws.com/demo/`, one folder per
  dataset, uploaded by `scripts/publish-demo.sh`. A `npm run build` is **19 MB
  instead of ~265 MB**, and 12 MB of what is left is the source map.

  Size was the smaller half of it. Same-origin hosting waived the CORS
  requirements of §11 and failed a different one: GitHub Pages gzips
  `application/octet-stream`, which is what it served every `.metacool` and
  `.mcool` as, and a `Range` over a compressed body addresses the octets of the
  *compressed* stream. Every demo therefore opened through the whole-object
  fallback — the probe saw `Content-Encoding`, refused the ranged path, and the
  worker downloaded the entire file into memory. The landing page was
  demonstrating the escape hatch rather than the reader. S3 does not compress
  that type, so the demos now take the bounded-range path: the one a reader's
  own bucket will take. What comes back is the CORS half — a preflight, and
  `Content-Length` and `Content-Range` exposed to JavaScript — which
  `publish-demo.sh` configures and then verifies with hosting.md's three `curl`
  calls before it reports success.

  **No `.metacooler.json` changed a line.** The names inside a published
  session are relative and are resolved against the session's own URL, so
  moving the folder moved the session with it — which is the property that made
  the whole change three edits instead of thirty, and the reason a dataset
  folder stays something you can copy to another bucket.

  The datasets stay checked out in the repository, under `demo/`, because that
  directory is both what the sync uploads and what
  `test/unit/demo-examples.test.ts` reads: disk and bucket are one tree, so a
  renamed file is a red CI run rather than a landing page where every choice
  404s. They are in git history either way — removing them from the tree would
  not shrink a clone.

  Two build configs lost a special case with it. The desktop build no longer
  needs `__DEMO_BASE__` pointed at the website (and no longer trips over the
  Pages 301 that carries no `Access-Control-Allow-Origin`), and the archived
  pinned build no longer points its examples back at the site root. Both now
  read the same URLs the web build does.

### Changed

- **The 1D browser's crosshair and readout follow the pointer below the tracks
  too.** The canvas used to stop at the foot of the last lane, so the space under
  the stack belonged to the column rather than to the plot and the pointer moved
  over it silently — which is a lot of dead surface on a view with two tracks in
  a tall window. The canvas now reaches the foot of the column, and pointing
  anywhere in it names a coordinate and reads every track at it, exactly as
  pointing at a track does.

  **Not before the axis begins.** The strip at the left is the handles' margin
  and, when it is on, the track names' column, and neither is a position: the
  crosshair stops at the axis and the readout says nothing there, rather than
  naming a base pair while the arrowhead is on a word. That was true of the
  readout already and is now true of the line as well.

  **Only what follows the pointer goes down there.** The sequence boundaries and
  the name column's own edge stop with the tracks: a boundary is a mark *on* the
  tracks, and a rule carrying it through a screen's worth of blank space is a
  divider between two things that are not there.

  Only on screen. A figure is a picture of the tracks, and blank paper under them
  is not part of it, so an exported one is unchanged.

### Fixed

- **The last lane of a stack shows the rule on its resize border**, which it
  never has. The rule is drawn a pixel *outside* the lane, in the gap before the
  next one — and the last lane has no gap, because its far edge is the canvas's
  own end: the whole two-pixel stroke landed outside the canvas and was clipped
  away. The drag went on working perfectly, which is the worst of the two
  failures, because a gesture that is never announced is one a reader finds by
  accident or not at all. It is now held inside the canvas by its own half-width,
  which costs every other lane nothing since they are nowhere near either end.

### Added

- **The example list is a shelf of sessions.** Every entry in the landing
  page's dropdown is now a `.metacooler.json` published beside the data it
  names, and nothing else — three of them, in `demo/`. A `.cool` in a
  dropdown can only ever offer what dropping that `.cool` offers: a map at its
  landing view, with nothing beside it. What a first-time reader should meet is
  the application doing its job, and that has been writable as a file since the
  export button shipped, so it is written as one.

  **Mock microbial community** opens the 1/2/4 kb ladder at its finest level,
  on the genomes table with the largest MAG first. **Yeast micro-C** opens the
  balanced 1 kb map at `IV:1.0–1.4 Mb` with the gene model along *both* edges,
  ATAC and its peak calls under the map, Pol II over input and its peaks beside
  it, and 1,506 loop calls drawn on it. **Yeast chromatin and transcription**
  opens the same assembly with no contact map at all: nine lanes over chromosome
  IV, MNase and ATAC in one group on pinned axes, the two RNA strands sharing
  one axis with the reverse strand read downwards, and the strain's own sequence
  as GC content above them all.

  The sequence is published with them: `S288c_syn40-XIII.fa`, the map's sixteen
  sequences residue for residue — `III` at 315,525 and `XIII-syn40` at 964,431,
  no `Mito` — so the lane is the genome the map is of rather than the reference
  it was lifted from. Both yeast sessions draw it, on both edges beside the map.
  It is deliberately *not* in the "load the tracks published with this map"
  button: a FASTA is read whole and held whole, and twelve megabytes of residues
  arriving from a button labelled that way would be a surprise.

- **A session can be opened by URL.** A `.json` in the picker's URL box, or in
  the list, is fetched, parsed and applied — the published counterpart of
  dropping one, and the same code after the first line. Which is what makes a
  session something you can *link to* rather than only send.

- **A published session names its files relatively.** An exported session names
  the absolute URLs the tab it came from was reading; one that ships *with* its
  data cannot, because the same directory is served from `/` in dev, `/<repo>/`
  on Pages and a third origin in the desktop build. Relative names are now
  resolved against the session's own URL on the way in, the way an `<img src>`
  in a page is, so one directory of sessions works in all three. An exported
  session is untouched by it, and a file may mix the two.

- **A track's name is edited where it is drawn.** The label pass measured every
  name and forgot it, exactly as it once did the value range; it hands the boxes
  back now, and a press on one opens a caret over it — in the 1D browser and
  beside the map, one editor for both. A name commits to the one track it names,
  unlike the range, which commits to every track in the lane because a lane draws
  one axis.

- **A map is a thing you can put down.** Compare becomes **Contact maps**, at the
  top of the Annotations column, with one row per open map wearing the same
  mark-name-eye-× head a track's row wears. The eye on the first map hides the
  matrix — which *is* the 1D genome browser, the same tracks against the same
  genome with the picture taken out — and the file stays open behind it, so the
  trip back costs one press. The eye on the second takes the lower-left triangle
  away without putting its reader down. `V` does the same from anywhere, as does
  an icon-and-word button on the title line beside the search box. The window
  comes across: hiding a map opens the browser where the map was looking, and
  showing it again restores the parked view exactly, down to the colour clip.

  The one-way door has left the File card, where it was the only way out of the
  matrix: it is the × beside the name now, next to the eye it is not. A browser
  started from a track gets the card too, with an empty slot to drop a map on.

- **The box beside a map finds genes.** It only ever spoke coordinates, so typing
  `GAL4` navigated to `region=GAL4` and came back with "unknown label" — on a
  whole-genome map of a mammal, which is three pixels per chromosome arm and is
  precisely where naming a gene is the only way to get anywhere. The scan is the
  browser's, shared, and it returns *numbers*: the browser writes 1-based loci
  and a map reads 0-based half-open regions.

- **Coordinates on a 2D drag.** A marquee on the map drew a shaded square and
  nothing else. It writes both ends and the width now, on both axes — a square in
  pixels is two different spans in base pairs the moment the axes are two
  sequences — each chip outside its own edge so it never covers what it measures.
  On the diagonal the two axes say the same thing and it is said once. The chips
  and the region that opens come from one derivation, so they cannot disagree.

- **The line under a map says what window it is showing.** `3,786 × 3,786 bins ·
  effective resolution: 600 bp` is two facts about the block and none about the
  picture. It carries `Pf3D7_05_v3:1,001-24,600 · 23.6 kb` now, in the browser's
  own words and grammar, updated in the same frame the map is drawn in.

- **One text size for every picture.** A pair of presses in both Plot cards
  scales every canvas font in the app together — track names, value ranges,
  ruler coordinates, gene names, block labels, colourbar ticks, export captions —
  and every line height, click box and label band that was measured against one.
  A multiplier rather than a size, because the sixteen sizes written down across
  the app were each chosen against the thing they sit on.

- **Shrink, next to stretch.** Stretch answers "use the space I have"; shrink
  answers "give it back, to the size I already chose for one of these" — the
  shortest lane on screen rather than the floor. All tracks at once, and within a
  group beside the button that levels a group to its tallest.

- **A name column with a width of its own.** Its edge is draggable, and a double
  click hands it back to the names. A name too long for a pinned column wraps to a
  second line, breaking where the writer said a part ends, and is cut in the
  middle — `Yeast_…-input` — when even two lines will not hold it, because the
  ends of an experiment's name are where the information is.

- **The Aesthetics column is four cards, named after what they draw on.** *View*
  is **Map** and holds everything that touches the matrix — the transform, the
  colourmap, the clip, the refit, and the four overlays that spent a release
  under a label at the foot of a card about the tracks. *Plot* is **Tracks** and
  holds the lanes and nothing else. **Export** is its own card at the top of the
  column, because saving a figure is not a property of the picture: it is what a
  reader does once everything else is where they want it.

- **⌘C copies the plot.** The figure as a PNG on the clipboard, at the Export
  card's resolution, from the system copy chord or from the button beside the
  save — in the browser and beside a map. It stands down when the keystroke is
  really about text: with a selection live or the caret in a box, ⌘C is still the
  browser's.

- **Shift with the zoom modifier pins the marquee to the diagonal.** The press
  snaps to the nearest bin *on* the diagonal and the far corner stays on it, so
  the box a reader draws over a domain is square about the diagonal by
  construction rather than by a steady hand. The diagonal is where the two axes
  name the same bin, so an off-diagonal panel gets no false one.

- **Clicking a feature opens its card.** Names, position, length, strand, score,
  the GTF attributes the parser kept — gene id, biotype, source — the coding span
  and the exons, in a panel that stays open and can be copied out of. The same
  card in the browser and in a map's lanes, for the same gesture on the same
  gene. Zooming to the feature is still there, as a button inside it.

- **The text on every picture starts at 135%**, and the track outline starts on.
  Both are the sizes and marks the renderers were written against, moved to what
  a contact map read at a desk actually needs; both are one press from where they
  were, and the identity is still a rung on the ladder.

- **Track height and transparency are steppers**, the shape text size already
  had: a box between two chevrons, a pixel a press for the height and five per
  cent for the transparency. Text size and transparency share a line, being one
  question asked twice.

- **Shift over the map reads the diagonal.** Held while hovering, the readout
  snaps onto the nearest bin *on* the diagonal — the same line the Shift-locked
  marquee draws along — so a reader can see where on it they are before pressing
  the button. It answers the question a hand over a contact map is usually
  asking anyway: contact at this locus with itself is the reference every
  off-diagonal cell is read against, and at a fitted whole-genome view finding
  that line by eye is a two-pixel target.

- **Escape abandons a drag**, on the map and in the browser. A marquee is
  committed on release and a release cannot be taken back, so the only way out
  of a box drawn in the wrong place used to be letting it open somewhere and
  navigating back. A pan is rewound rather than merely stopped: a pan that ends
  where the reader changed their mind is the pan happening anyway.

- **The 4C anchor is drawn in whichever direction the hand went.** A band of rows
  and a band of columns name the same stretch of a map read about its diagonal,
  so insisting on a vertical drag was insisting on a gesture rather than on an
  answer — and a drag that came out a few degrees the wrong side of vertical gave
  a one-bin anchor with no hint why. The band on screen follows the same test, so
  what is drawn is what is taken, and on a rectangular block each direction is
  resolved through its own axis rather than through the rows.

- **The 4C strip comes out of the map's height budget.** It is furniture above
  the map in exactly the sense a track stack is furniture below it, and without
  saying so the map kept its size, the strip was added on top, and the tracks
  under the pair went below the fold. `--lane-top` joins `--lane-bottom` in the
  plot's `clamp`, so turning the strip on shrinks the map by the strip's height
  wherever height is what is binding.

- **A virtual 4C profile above the map.** A 4C experiment fixes one locus and
  asks what it touches; a contact map already holds the answer for every locus at
  once, and pulling one out is arithmetic a reader can do by eye and cannot do
  accurately. Turn the strip on from the Map card, Shift-drag a band of rows on
  the picture, and the lane above it draws the sum of every column over that
  band.

  Computed from the block already on screen and never from a fresh read, which
  is what makes it honest as well as free: the line is a summary of the pixels
  above it, at the same pooling, from the same score column, with the same
  balancing. A separately-read profile could disagree with the picture it is
  drawn over, and would, at every level but the finest.

  The strip is a canvas of its own in the panel's grid, exactly as wide as the
  map's and drawn through the map's own column scale — so a peak sits under the
  column it came from by construction rather than by arrangement. It draws
  through `drawTrack`, so it looks like the tracks beside it because it is one,
  and the fill, the outline and the floor follow the same overlay toggles. Shown
  and empty until an anchor is drawn, because that empty box is the only place a
  reader is certainly looking at the moment they need to be told the gesture.

  The anchor is kept as a **locus**, not as bins or block rows: pan, zoom, change
  resolution and it still names the same stretch of the same sequence. Panned
  away from, the lane says so rather than drawing a profile of whatever is at
  those row numbers now.

- **A score picker where the balanced tickbox was.** One dropdown in the Map
  card naming what the cells *are*: `counts`, `balanced` where the file carries
  weights, and then every further value column the file's own `/pixels` group
  holds, under its own name. cooler fixes three columns and lets a file carry
  more — an expected value, a second normalisation, a per-pixel significance —
  and a viewer that assumed `count` could not draw any of them, so a file that
  had gone to the trouble of storing one had no way of saying so. Present on
  metacools too, where before there was no control at all.

  The choice is one control because it is one question, though balancing is a
  transform and the others are columns: a tickbox beside a dropdown would be
  splitting "what am I looking at" across two places. `balance` stays in the
  view state exactly as it was, so every link written before this exists still
  resolves; `score` carries the rest.

- **The hover card can be put away.** A `tooltip` toggle beside the crosshair, in
  both Aesthetics rows and over one store, so pressing either moves both. The
  two things a reader does with a contact map want opposite answers: reading it
  is the card's whole reason to exist, and *looking* at it — framing a figure,
  showing it to somebody — is a thing the card is directly in the way of. The
  status line under the window carries the same reading and covers nothing, so
  turning it off costs a hover no information.

- **The crosshair is offered in both Aesthetics rows.** It is the one preference
  genuinely about both pictures — one pointer, guide lines through the matrix and
  through every lane — so it is in **Map** and in **Tracks**, one key over one
  store, and pressing either moves both.

- **Select everything the filters left, from the filter row.** The tables' "select
  all" button has gone, and a tick box sits in the gutter of the filter row
  instead — directly above the column of row checkboxes, on the line the filter
  boxes are on. It was already the filtered set the old button acted on, but it
  sat in the toolbar three controls away from the rows, with nothing about it
  saying which rows it meant; a reader who had filtered to six of sixteen read
  the words "select all" and could not tell from the toolbar which they had got.
  The box says it by where it is, and shows a third state — part-ticked — when
  some of what is showing is selected. Pressing it when everything showing is
  ticked unticks it. Rows a filter is hiding are left alone in both directions;
  "clear", renamed **clear selection**, is the one that empties everything.

- **A locus box on the two table views.** The landing screen of a cooler is its
  chromosome table and of a metacool its genome table, and both offered exactly
  two doors: a whole sequence by clicking its row, or the whole file from the
  toolbar. A reader who knew the ten kilobases they wanted had to open the
  chromosome around them and narrow from there — a large read taken to reach a
  small one, and the box that would have taken them straight there only appeared
  once they had paid for it. Both tables now carry the box, `/` opens it, and
  `chrIV:1,200,000-1,210,000` goes to a ten-bin block without the chromosome
  ever being read. The read path needed nothing: `readDenseMatrix` has always
  bounded a query by `bin1_offset`, so ten bins have always cost ten bins' worth
  of pixels — what was missing was somewhere to ask from.

- **Stretch and shrink are a mirrored pair.** `unfold-vertical` against
  `fold-vertical`, everywhere the two sit together: two arrows apart and two
  arrows together, which is what the pair actually does. The old mark was a
  different glyph that had to be read rather than seen.

### Fixed

- **A marquee dragged off the map stays alive.** The gesture is followed on the
  window until the button comes up, with every position clamped into the plot, so
  a corner taken past the edge of the data stops at the edge instead of taking
  the whole selection with it — and what is opened on release is the box that was
  drawn rather than wherever the pointer happened to be.

- **The browser's tooltip stays on screen.** It was clamped to the *stage*, which
  on a stack of a dozen tracks is several screens tall, so a value read near the
  foot of the window went under the edge of it. It is flipped and clamped against
  the window now, and its size is measured once a frame rather than on every
  pointer move.

- **A session naming a collection at its root kept its workspace.** A workspace
  is stored under the *file's* key, and an `.mmetacool` or `.mcool` addressed at
  its root does not stay under the URI it was asked for — it redirects onto one
  of its entries (§3.4). The tracks, groups and ticked sequences were written
  under the root's key and read back under the entry's, so the map arrived
  correctly and alone.

- **The Open-a-file dialog opens what the landing page opens.** It mounts the
  same picker with the same example list, and handed its answer to a different
  door — so an entry from the list arrived there as a file to open, and a
  published session was reported as a JSON file that is not a cooler.

- **The genomic distance across a cell came back.** Anything larger than the
  picture is read on a coarser grid, and a coarsened run carries no arithmetic
  origin past its first — so the "N apart" line had gone quiet on exactly the
  views that are always pooled. It is measured from the same function the two
  coordinates above it come from. `AxisGroup` gains `unitBin`, an identity rather
  than an origin, which is what a rectangular region view needs to know its two
  axes are the same contig.

- **Tracks no longer come back doubled after a reload.** Ids are minted from one
  on every page load and a restore re-introduces the previous load's, so the first
  file dropped afterwards was handed an id a restored row was already wearing —
  and two rows under one id move and die together, which is why deleting one of
  the twins deleted both. Ids handed in are reserved, a row begun twice replaces
  itself in its own slot, a duplicate already in storage is dropped on the way
  out, and a file dropped back onto a row this session put down re-attaches it
  instead of starting a second one from the defaults.

- **Feature names sit below their features beside the map**, as they already did
  in the browser. `labelBandOf` still refuses the band on a row too short to hold
  both, so a lane dragged down puts the names back inside the wide features.

## [0.8.0] - 2026-08-06

### Added

- **The tracks beside a map are the tracks in the browser.** Everything the 1D
  browser had grown and the heatmap's lanes had not, ported across — and ported
  by *moving* the implementation rather than copying it, so there is now one of
  each rather than two that agree today.

  On the lane itself: a **colour chip** before every track name, which is a
  click-to-recolour target on screen and a colour key in the exported figure —
  four lanes used to carry four names in one neutral grey. The **value range is
  editable where it is drawn**: a caret opens in the number itself, Enter
  commits, Escape leaves it, an inverted pair is refused in place, and the
  untouched end comes from the axis on screen rather than from the file's
  whole-genome extent. An **autoscale button** sits after the range, lit while
  the axis is the data's own. **⌘-scroll** (Alt elsewhere) over a lane moves that
  lane's ceiling, stepping from the range currently resolved rather than from a
  stored `[0, 1]` nobody chose.

  In the Aesthetics column: the **Groups card**, which existed only in the
  browser — beside a map a group could be *made* and then never inspected,
  undone or drawn differently. It lists each group's members with their colours,
  hides them together, takes one back out, levels them to their tallest, and
  carries the two mode toggles. **Overlay** now works beside the map: a group can
  collapse into one lane, its members blended, with a column of coloured names
  and one range under them. So does **scale each** — the setting was stored,
  honoured in the browser and silently ignored beside the map, which is the
  stored value and the picture disagreeing. A **stretch** button and a **track
  height** box join the Plot card, and `H` works in a map session.

  And in the picture, a **bar marking each run of lanes that share an axis**.
  A group was honoured numerically the moment it was made and drawn nowhere, so
  two tracks on one axis and two that happen to agree looked identical.

- **Drag a track's body to set its ceiling.** Press in a lane and move across it
  — up and down below the map, left and right beside it — and the value axis
  follows the hand. While the drag is under way the area **stays where it was**,
  faded, as the record of the range being left behind; only the top line moves.
  One trace lifting off its own shadow says what a number changing in a corner
  could not. Nothing is written until you let go, which is what lets the shadow
  stand still. Which screen direction means *more* is asked of the lane rather
  than assumed: it is opposite on the two edges and reversed again by a flip.

- **A track outline.** One toggle in either Plot card (`I`) draws a hairline
  along the top of every track, in the plot's ink rather than in the track's own
  colour. The boundary between an area's ink and the paper is the only part of
  it carrying information, and in its own colour it is the one edge that does not
  stand out — four stacked areas become four legible shapes.

- **`Reds` in the colormap picker** — ColorBrewer's sequential red, anchored at
  paper white rather than at its own lowest stop. That stop is `#FFF5F0`, a pale
  pink, and most of a Hi-C matrix is empty: on matplotlib's ramp the map is a
  sheet of faint pink with the data on it, and the eye reads the tint as signal
  until it works out that it is everywhere. The two agree from a ninth of the way
  up, so what differs from `metacooler show --cmap Reds` is the floor rather than
  the hue.

### Changed

- **A track moved to the right of the map turns round.** Below the map a lane
  grows *up*, towards the matrix; beside it the same track grew *away* from it,
  so a figure with both stacks disagreed with itself about which way was more.
  Moving a track between the two edges now flips its axis, and a file dropped on
  the right edge arrives already turned. A **toggle**, not an assignment: a
  reader who deliberately hung a bottom track from its ceiling gets that back
  when it comes home.

- **A right-hand lane's name is off its own ink.** The caption was pinned to the
  edge nearest the map, which on that stack is where the signal grows from; it
  now goes to whichever end of the lane the baseline is not at, which is the rule
  the bottom stack always followed. A flipped track's name moves with it — and
  keeps its caret, which it used to lose.

### Fixed

- **A lane dragged by its handle beside the map landed on the wrong slot.** The
  drop position was a *drawn-lane* index handed to a reorder that indexes the
  card's whole list, so with any track hidden, still loading, or on the other
  edge the lane landed a slot early and the last slot could not be reached at
  all. Every drag now resolves its target by identity, and fires once per slot
  crossed rather than once per pointer move.

- **A cancelled lane drag no longer commits it.** `pointercancel` was bound to
  the same handler as a release, so a drag the system interrupted over a lit
  edge rectangle still moved the track to that edge.

- **One floor for a lane's height instead of three.** Fourteen pixels in the
  browser, twelve in the panel and ten in the lane stack, so a lane dragged to
  eleven was legal on one surface and rounded on another. Twelve everywhere; a
  lane below it comes back a pixel or two taller on the next reload.

## [0.7.0] - 2026-08-06

### Fixed

- **Picking the newest build did nothing, on the one page where it mattered.**
  Reported from the deployed site: the menu showed `0.6.0` selected with
  `0.6.1` marked *latest*, and choosing `0.6.1` reloaded quickly and changed
  nothing at all.

  Every part of that was working as built. A visitor at the site root is served
  by their service worker, whose cache was a build old — which is the design,
  since an update installs and *waits* for consent rather than swapping code
  under a half-read file. The picker sent them to the site root. The worker
  answered that navigation from the same cache. Nothing in the round trip ever
  asked the network for anything, so it would have done that for ever.

  The newest build is now **taken** rather than navigated to: check for an
  update now, take what is waiting by the same `skip-waiting` handshake the
  update bar uses, and only if the shell is known stale and nothing is waiting,
  drop the worker and reload. The first path replaces the cache rather than
  dropping it, and so keeps offline.

  The state is no longer silent either. When the running build is not the one
  the root publishes, the dialog now says which build is on screen, which one
  the site has, and that an ordinary reload will not fetch it — the absence of
  that sentence is what made this hard to read from the outside.

  This cannot rescue a page that is *already* stuck, since that page is running
  the code without the fix. The update bar is the way out of one, as it always
  was.

- **A drawn pixel no longer straddles two sequences.** A metagenome view was
  reducing the same picture three times over, and two of the three did not know
  where the contigs were: the read summed bins into contig-snapped cells, the
  renderer then pooled *those* into raster pixels flat and two at a time, and the
  browser filtered the result down to the screen. On a 4,882-contig genome each
  drawn pixel therefore held two different contigs and was coloured by the
  brighter of their two diagonals, so pairs of sequences that never touched were
  drawn as one solid block on the diagonal — with the boundary hairline running
  through the middle of it, because the separators were the one layer still drawn
  at the true positions.

  There is now one rule and one place that keeps it: a cell is a run of bins
  inside one sequence, or a run of *whole* sequences, never part of one plus
  something else. `partitionAxis` builds every grid in the app against a cap it
  never exceeds, so the grid the reader builds is the grid the renderer draws and
  nothing pools a second time. `POOLED_CELL_LIMIT` — the 1,024 cells of slack
  that guaranteed the second pooling for any axis between 4,096 and 5,120 cells —
  is gone, and so is `flatBinPooling`, which above 5,120 contigs was mixing whole
  sequences together *in the data* rather than only in the picture.

- **Where sequences outnumber pixels, cells hold whole sequences and say so.** An
  axis of 4,882 contigs cannot give each one a cell in a 4,096-pixel picture, and
  the old answer was to pretend otherwise. Now such a cell is a named set of whole
  sequences, summed, kept inside one genome — the rule the metagenome overview
  already applied to its slots, for the same reason and for the further one that a
  cell belonging to exactly one genome is a cell that can be clicked through. The
  summary states it in the unit the cells actually are: `2 contigs per cell,
  summed`, rather than a base-pair width that no longer means anything.

- **The genome view plans its grid instead of asking for whatever fits.** It sent
  no resolution at all, so a genome of thousands of contigs arrived as a dense
  block that the renderer coarsened on arrival — the path the report above came
  through — and a mammalian chromosome at 10 kb was refused outright for being
  larger than one typed array. The reader now plans any block that begins on a
  contig boundary and reports the plan it used, which is where the view reads its
  resolution from. A region starting mid-contig is left alone: its coordinate
  origin has no cell in a coarse grid, and moving it silently is worse than
  refusing by size.

### Changed

- **The line under a map says two things and stops.** How large the picture is
  and what one cell of it is worth — `4,046 × 4,046 bins · **effective
  resolution: 3.0 kb**` — from one function all four views share, so they cannot
  drift apart on the same fact. Gone from it: `matched chromosome XV ·` and
  `XV × XV ·`, which the title above already says; `bins 28,911–34,679` and
  `contacts between the two regions`, which nobody reads; and `· balanced`,
  which is the colourbar's to say, in the units it is drawn in, beside the
  numbers it applies to.

  The count is the **cells**, and they are called bins, because a cell of the
  picture *is* a bin of the effective resolution: `4,046 × 4,046` at `3.0 kb`
  multiplies out to the 12.1 Mb on screen. Counting the file's own bins would
  put `5,769 bins` beside `200 bp` for a 577 kb chromosome — two numbers on one
  line describing something twice its size. Above one sequence per cell there is
  no bin to speak of, and they are cells again.

- **A cell is a capacity of bins, not a count of sequences.** The first version
  of this had two rules, and the second was wrong: past the point where an
  assembly's sequences outnumbered the cells, *every* cell took a fixed number of
  whole sequences — so a contig of four bins was crushed into half a cell beside
  a contig of one, while the picture had room to draw all four. One rule now: a
  cell holds at most `k` bins and never part of one sequence beside anything
  else. A sequence longer than `k` keeps cells of its own, cut at its own start;
  only the ones too small to fill a cell share. On a 6,174-contig genome at 10 kb
  that is 3,100 cells of 20 kb, with the four-bin contig drawn as two cells and
  the one-bin contigs two to a cell — where before it was one cell for both, and
  the four-bin contig had lost its inside.

- **A group is one sequence, however many cells it spans.** The first cut of the
  membership list walked a group's cells and named the sequence in each, so a
  contig longer than the capacity — which has several cells of its own — was
  listed once per cell: its name appeared twice in the sequence list, its cell
  described itself as holding two sequences, and the bin count was suppressed
  because the cell looked shared. Members are the *distinct* sequences now.

- **The sequence list counts a sequence's own bins.** It was showing
  `end - start`, which counts the **cells** a sequence is drawn in — so a contig
  of two bins read "1 bins" the moment the capacity reached two. It comes from
  the sequence's own length now, which is the number that does not move when the
  picture is coarsened.

- **A shared cell says what is in it.** It used to be labelled with the first
  sequence and nothing else, so the readout named one of two and gave it a
  coordinate inside a cell that is not only its (`Contig_184898`, `0 bp × 0 bp`),
  and the sequence list beside the map listed one contig in two. The readout now
  names them — `Contig_184898 + Contig_321167` — and the list is built from what
  the cells *hold* rather than from what they are labelled with, so every
  sequence is there and every one of them opens.

- **The metagenome's own views join the rest.** Three of them were reducing a
  second time behind the reader:

  - the **whole-metagenome overview** capped its axis at 16,384 units where the
    renderer draws 4,096, so the last two steps were taken flat and blind to the
    genome boundaries `poolUnits` had just snapped to — sixteen genome pairs to a
    pixel, the pointer resolving one of them. The cap is the raster's width now.
    It was a *memory* bound, and memory was never what binds a picture four
    thousand pixels wide;
  - the **contig-level roll-up** had no bound at all: one cell per contig, so a
    genome of 4,882 contigs was a 190 MB accumulator for a 4,096-pixel picture,
    pooled two contigs to a pixel on arrival. It is coarsened where it is built
    now, by the same partition the bin grid uses, inside one genome;
  - the **genome-pair view** stated no resolution at all, and can be pooled like
    any other block.

  All four metacool views — genomes, genome, genome pair, region — and the
  overview now draw the same line, from the same function.

- **The overview says it once.** Under the map it used to add "7,748 contigs are
  more than are readable at once, so each row sums about 2 consecutive contigs,
  never across a genome boundary. Every one is included." — which is the summary's
  `2 contigs per cell, summed` at length, and dates from when the same view threw
  98% of the contigs away and had to promise it no longer did. The line says it;
  the paragraph is gone. So is `· full scan`: where the numbers came from is not
  a property of the picture, and the gate above asked before the scan ran.

- **A selection is the same axis, scattered.** It was the last path on the old
  rule: a cell opened at every ticked sequence, so the axis could not fall below
  the number of them however coarse the bins were made. Past the cap the renderer
  pooled what arrived, flat and blind to the sequences — and far past it, `select
  all` on a large metagenome asked for an accumulator of `cells²` that the machine
  refused, where the previous release had at least said "Select fewer sequences".
  It takes the range's capacity now, so a large sequence keeps its own cells among
  small ones, shared cells name what they hold, and ticking twenty thousand
  contigs is a picture.

- **A selection reads only the sequences it asked for.** Pixels are sorted by
  `bin1`, so every pixel a selection wants lies in the row band of one of its own
  sequences, and `bin1_offset` — already in memory — says where each band is in
  two lookups. Bands are merged where the gap is smaller than the byte source's
  own chunk and walked as one operation, with one progress count. Four MAGs out
  of two thousand used to cost a pass over every stored pixel in the file.

- **`__unbinned__` is out of the whole-file view.** It is not a genome and is
  shown nowhere else (§7.4) — absent from the tables, unselectable, excluded from
  the overview — but the whole-file map read `[0, nBins)` and drew it. On a
  1.9 M-bin metagenome that is 56% of the bins: a band across the picture, and,
  being among the drawn pixels, the thing setting the auto `vmax` for everything
  else. Under `genome-then-length` it is one contiguous range at index 0, so
  leaving it out is a range rather than a gap.

### Known

- **A pooled balanced block is an approximation, and now says nothing about it.**
  Summing balanced values is not balancing at a coarser resolution — the marginals
  of a `k`-bin cell are `k` times a fine bin's, which is why `cooler zoomify
  --balance` re-balances every level from raw counts rather than summing the level
  below. A second cost is quieter: a filtered bin carries a `NaN` weight, the
  dense read multiplies it through so the whole row draws transparent (§6.4, "a
  blank row is an unbalanced row"), and a pooled read drops `NaN` contributions
  instead, so that row returns as an ordinary number. The whole-file view has done
  this since pooling was added; the views above now do it too, because the
  alternative — keeping balanced blocks dense — refuses a mammalian chromosome
  outright and draws everything else through a contig-blind raster. Balancing at
  the read's own resolution, and taking a coarser rung of a laddered `.mcool`
  where one exists, are the real answers and are not attempted here.

- **A coarse cell belongs to the sequence, not to the question.** The grid falls
  at `contigStart + m·k` whatever range was asked for, and a request is widened to
  those edges rather than starting its own grid at its own left edge. So a base
  pair lands in the same cell, holding the same sum, in every view of it, and a
  region of a chromosome now behaves exactly as the chromosome does: one
  coordinate under one pixel, showing the sum beneath it. It also gives the first
  cell a place in the contig's own coordinates — a block opening 320 kb in used to
  call its first cell 0 bp — which is what let the restriction go that kept
  mid-contig regions on the dense path. At most `k − 1` bins are added at each
  end, and the range reported is the range drawn.

- **The reader plans the grid exactly rather than from a bound.**
  `poolPlan`'s `n / (cap − contigs)` is what a *caller* needs, having to name a
  resolution before anything is read. The reader has the contig extents in hand,
  so it searches for the smallest grid that fits — which at a bin count just over
  a multiple of the cap is a whole step finer than the bound allows.

- **Selections larger than the picture are drawn rather than refused.** "This
  selection is 6,000 cells per axis … Select fewer sequences" is a strange thing
  to say to someone who has just ticked *select all*. The axis is named sequences
  either way; only how many share a cell was ever in question, and that is a
  number the summary can state.

- **The summary counts the assembly, not the pooling.** An axis run is one cell's
  name, so counting runs counts cells — and a 4,882-contig genome was reported as
  "across 2,441 contigs" the moment its cells held two apiece.

- **Filtering is decided in the pixels it happens in.** `imageSmoothingEnabled`
  was tested in CSS pixels while the image was placed in device pixels, so on a
  2x display everything between one and two raster pixels per device pixel was
  *magnified* through a bilinear filter — the one combination with nothing to
  recommend it. The same slip applied to every export, where the DPI scale takes
  the place of the device ratio, so a 300 dpi figure was asked the screen's
  question.

## [0.6.1] - 2026-08-05

### Added

- **A dropdown that runs another commit.** The site is built from `main` on
  every push and has only ever served the newest of those builds, which is fine
  until a figure comes out different from one made last month. Every deploy now
  also publishes a copy of itself at `…/v/<commit>/`, keeps the recent ones
  beside it, and lists them in `versions.json`; **About → version** offers them
  as a menu directly under the build stamp it continues.

  Picking one is a navigation and not a swap — the two builds are different
  documents, and pretending otherwise would mean shipping a loader whose job is
  to run code from another commit. What travels is what is written down: the
  query string, the hash and the `sessionStorage` tab strip, so a link and a
  view survive the move. A file opened from local disk does not, for the reason
  it does not survive a reload either, and the hint says so rather than letting
  it be discovered. An archived build says what it is in a corner bar, with one
  button back to the newest.

  What is kept is the **last 20 pushes** — the debugging window; past fifty the
  answer is a bisect rather than a menu — and **every tagged commit, for ever**,
  which is the archive proper and the reason to cut a release even though every
  push is already live. A released number is something people cite in a methods
  section, and one that answers 404 two months later is worse than never having
  offered it.

  A release also gets a **permanent address of its own**, `…/v/v0.5.1/`, which
  is a one-kilobyte redirect to the commit rather than a second copy of it. That
  is the URL worth writing down: a commit URL is equally permanent and says
  nothing to a reader. It carries the query and the hash across, so a citation
  can name a *view* of a release and not only the build, and the About dialog
  offers it whenever the build in front of you is one. Tags are read with
  `git ls-remote --tags` — asking the server for its ref names costs a few
  kilobytes, where fetching tags into a depth-1 checkout would drag down an
  object per tag in a repository carrying 250 MB of demo data.

  Kept alongside that is **the oldest build of each `package.json` version**,
  which is the same rule for a release whose tag was pushed after its commit.
  The *oldest* is deliberate and the obvious alternative is wrong: `npm version`
  bumps the version and tags that commit, so every push until the next bump
  reports the same number — keeping the newest would keep a build that calls
  itself `0.6.0`, is labelled `0.6.0` in the menu, and is not `v0.6.0`. That is
  worse than keeping nothing, because it is wrong rather than absent.

  An archived copy leaves out the demo data, the source maps, the manifest and
  the service worker (`vite.pinned.config.ts`), which is ~5 MB against a build's
  19 MB and is what makes keeping twenty affordable inside a 1 GB Pages site.
  Deliberately **not** installable: a dock icon must not open a version
  somebody pinned once to check a figure. None of it exists in the desktop
  build, where an installer is versioned by being an installer.

  Each of those four properties is asserted after the build rather than trusted
  (`scripts/check-pinned-build.mjs`), because each fails quietly and *late*: an
  archived build is the artifact nobody opens for months, so a wrong base is a
  blank page found in November, and a `publicDir` left on exhausts the site's
  budget several deploys after the change that caused it.

## [0.6.0] - 2026-08-05

### Added

- **Tabs, and a real session behind each one.** Several files open at once, each
  with its own reader worker, its own annotation worker, its own stores and its
  own DOM. Switching a tab in re-parents that DOM rather than rebuilding it, so
  a map comes back with its pixels, its zoom and its scroll exactly as they
  were and without a single byte re-read — which is what a tab has to be for it
  to be worth having over a second browser window.

  The address bar names **the active tab and nothing else**, which is what was
  asked for and also the only coherent answer: a hash is one view state, and
  writing several would make every link a description of somebody else's
  workspace and make the back button walk a history that interleaves three
  files. The rest of the strip lives in `sessionStorage` beside the annotations
  (§8.6), and a restored tab is *named* rather than opened — the label and the
  view state come back, the worker does not, and clicking is what reads the
  file. Eight remembered tabs therefore cost eight labels. One that named a
  local file comes back to the picker with the explanation a pasted local-file
  link has always given, because no browser re-reads a dropped file without a
  gesture.

  Two tabs on one file now share nothing: the per-session memory is keyed on the
  session as well as the URI, so the second view starts with no tracks, no
  filters and no marks rather than adopting the first one's.

- **A second cooler in the lower-left triangle.** A contact matrix is symmetric,
  so half of every square on screen is a mirror of the other half and carries no
  information at all. That is the room this uses: the second file fills it, the
  picture stops being symmetric, and a broken symmetry is read far faster than
  two maps side by side.

  The split is the **matrix** diagonal, not the viewport's, which is what makes
  panning off the diagonal need no rule of its own — the far corner of a trans
  block is entirely above the line and shows the first file alone, and its
  transpose shows the second. Zoom, selection and every other gesture are
  untouched, because the merge happens once per read and hands the renderer an
  ordinary block.

  Dropped on a card in the Annotations column, where everything else that is
  laid over a map already lives. Refused *by name*: a metacool (§8.5's argument,
  applied to a whole matrix), a different bin size (one grid cannot be two
  resolutions), or a chromosome list differing in count, order, spelling or
  length (every coordinate is an index into one such list). An `.mcool` dropped
  at its root opens its finest resolution, as it does on the picker.

  GENERAL becomes File 1 and File 2, each with the mark of its own triangle and
  a close button: closing the second returns to one map, closing the first
  promotes the second, so either is reversible and what remains is an ordinary
  one-file map. `uri2` is in the hash, so a comparison is a link.

  One scale by default, because the same colour meaning the same count is the
  stronger claim. **Match depth** scales the second file so its 99th percentile
  meets the first's — the same order statistic §7.1 picks `vmax` with — for the
  case that motivates it: two libraries of different depth, where the shallower
  is otherwise a pale triangle telling you only that it was sequenced less. Two
  colourbars then read the same colours in each file's own counts, and the
  tooltip and the status line carry both numbers at every cell.

- **A genome browser that needs no contact map.** Until now a bigWig could only
  be looked at beside a cooler of the same assembly, and that was never a
  property of the tracks — it was a property of the coordinate model, which
  started from a matrix and had no way to describe a genome that was not one.

  So there is a second starting point. A `chrom.sizes`, a bigWig, a bigBed or a
  feature file declares the assembly — outright in the first three cases, and as
  a lower bound in the fourth, which is marked as inferred wherever the genome
  is described — and the axis becomes the whole genome laid end to end at one
  unit per base pair. Everything drawn on it is drawn by the code that draws the
  lanes beside a heatmap, through the same `LocusAxis` §8.4 already made the
  only one: a track cannot be at two positions because only one thing knows
  where a base pair is.

  The gestures are the map's, deliberately. A drag pans, Option-drag selects a
  range to zoom into, the wheel zooms about the pointer, a double click fits, a
  lane's border resizes it and its body reorders the stack — every one of them
  the gesture that already meant that. The one that is the browser's own is
  ⌘-scroll over a lane, which moves *that* track's ceiling from whatever it is
  currently resolved to; it is the adjustment a genome browser is asked for
  constantly and a map has no analogue for it.

  With it: a locus box that accepts `chrI:1,000-20,000`, a bare sequence name or
  `*`, and shows back exactly what it would accept; a feature search over every
  loaded gene model and peak set; click a gene to zoom to it and a sequence name
  to go there; a ruler that draws sequence bands zoomed out and base pairs
  zoomed in, because at those two extremes they are different questions; arcs
  for a BEDPE, which is what a loop call looks like in one dimension; range and
  group editors on each lane, revealed by pointing at it; autoscale groups that
  stack or share a single lane; and PDF/PNG export redrawn at the export scale.

  The two shapes of browser are one session. Drop a `.cool` anywhere on the
  tracks and the tab becomes its map, tracks and all; close the map from the
  File card and it falls back to a browser on the cooler's own `/chroms`, with
  the same tracks still loaded. A file whose name says nothing is opened as a
  map and, if that fails, identified by its bytes and re-routed rather than
  reported as broken.

- **bigBed is read.** Whole, and parsed as the BED it holds, so a bigBed12 draws
  its exons exactly as the text file would — one parser, one set of rules, one
  place where BED's quirks live. Not windowed, because a `FeatureSet` lives on
  the main thread precisely so that a pan redraws with no round trip (§8.4). A
  file past a million intervals is cut off and says so.

- **The 1D browser exports a vector PDF**, and it is the drawing rather than a
  photograph of it. Nothing in that view is a raster — every mark is a
  rectangle, a polyline or a word — so a 300 dpi image of it is a figure nobody
  can restyle, recolour or scale, in a file fifty times the size of the drawing
  it contains. The page is produced by handing the *same* renderers a context
  that emits PDF operators instead of pixels, so there is no second drawing of
  the view to keep in step: `render/features.ts`, `render/tracks.ts`,
  `render/lane.ts` and `render/browser.ts` do not know which one they are
  talking to. Text is Helvetica, one of the fourteen fonts every reader has, so
  nothing is embedded; the halo behind each track name survives as PDF's own
  stroked text mode; and the content stream is deflated, which on a whole-genome
  gene model is the difference between a twelve-megabyte figure and a
  seven-hundred-kilobyte one. A vector page has no resolution, so the DPI
  control is disabled while it is chosen rather than quietly ignored. The
  heatmap's PDF is unchanged and stays a raster, because a contact map *is* one.

- **The tracks answer to a hand, and the panel answers to a list.** Rows
  reorder by their grip or by the arrow keys, and a lane reorders by dragging
  its body; a tick box on each row opens a batch bar that puts several tracks in
  one autoscale group, gives them one colour, one height, or removes them
  together — six tracks from one experiment were six trips through six rows. A
  colour swatch sits beside each name and *is* the colour input, so changing a
  track's colour is one click rather than a menu. Every track's name is larger
  and its controls smaller: colour, limits, a ceiling slider and its group, laid
  out under the name where a reader is already looking, revealed by pointing at
  the lane and drawn over the top of it rather than across its data.

- **A drag on the ruler zooms, with no modifier.** The coordinate strip is where
  a reader points to say "this much", and it is the one gesture whose meaning
  its position already settles — so spending a keystroke on it bought nothing.
  Option-drag still selects on the tracks themselves, where a drag means pan.

- **Fit every track into the space there is**, in the proportions they are
  already in rather than equally: a reader who gave the gene model three times
  the height of a coverage track meant it, and "fit" is a request about the
  stack running off the bottom of the window. Equal heights is the other thing,
  and the Groups card still offers it per group.

- **A file dropped anywhere in the middle of the window is imported.** The drop
  zones in the Annotations column say what each kind of file becomes and are
  still there, but a reader with a bigWig in hand and a browser on screen means
  one thing by dropping it, and asking them to find the right box first is a
  step that answers a question nobody had.

- **Gene names sit under the features**, in a band of their own, so a name never
  covers the exon structure it belongs to; below the height where that band
  would leave no room for a glyph they go back inside, which is what a lane
  dragged very short should do.

- **Aesthetics can turn every word off.** One toggle hides track names, value
  ranges and feature names together, leaving the ink — which is what a figure
  destined for a caption usually wants, and what a screenshot of six tracks
  usually does not. Shared with the heatmap's own panel and the command palette,
  so all three agree.

- **Chromosome boundaries are drawn**, as a full-height rule between sequences,
  and the ruler bands alternate by the sequence's position in the assembly
  rather than by its position on screen — so a boundary does not change shade
  when a pan brings a new sequence into view.

- **The tabs are shaped like tabs**, with tilted sides, the active one raised
  and lit along its top edge, and the pointer is the same black-filled arrowhead
  over the tracks that it is over the map. The × appears on the tab under the
  pointer and on no other — including the active one, which used to be an
  exception — and it lost the bordered box that was most of what the corner of a
  tab showed. One session is a title rather than a tab: the strip stays, because
  the way to a second session is the button on it, but a lone trapezoid with an
  accent bar is machinery announcing a choice nobody has been offered.

- **Every sequence in the genome, with its length, under the Genome card.** The
  first question a genome browser is asked, and until now the only answer was a
  count. Each row is a click that goes there, which is also the fastest way to
  navigate — a chromosome *is* a locus, and the locus box is for the case where
  you already know the coordinate. The bar behind each row is its length against
  the longest, which costs a gradient and turns a column of numbers into the
  shape of an assembly: sixteen bars in a staircase is a yeast, one bar with a
  thousand slivers under it is a draft. A filter appears above a dozen
  sequences, and at most three hundred rows are built at once, because forty
  thousand scaffolds is a second of layout for a list nobody scrolled to the end
  of.

- **A track's range is under its name, and you can type in it.** Two changes
  that are one change. A number at the far end of a lane from the name it
  belongs to has to be paired up by eye every time, and with four tracks stacked
  that is four crossings of the window — so it moved under the name. And a
  number that is under its name is a number you can put a caret in: hovering
  either end gives a text cursor, and clicking opens a box exactly where the
  number was drawn, so nothing moves when it becomes editable. Typing a bound
  turns autoscale off, because that is what typing a bound means. The two boxes
  that used to live in the lane's hover row are gone with it — the range is
  edited where it is read now, and what is left there is `auto`, the ceiling
  slider, the colour and the group.

- **A toggle for the shading under a track's line.** The pale envelope that says
  what a zoomed-out mean hid, and the fill an area track carries: one switch,
  because they are one thing to the eye. Both are *context* for the line, and
  context is the first thing to go when three tracks share a lane or a figure is
  going into a caption. Shared with the heatmap's own panel and the command
  palette, like the track-text toggle beside it.

- **The Plot card is marks rather than sentences.** Fit across, fit down, words
  on or off, shading on or off — four things a reader does over and over while
  reading, in a row of four icons instead of a column of full-width buttons
  spelling each of them out. The same two fit marks are on the toolbar above the
  tracks, because they are the same two actions. And the export controls are one
  line again: a vector page has no resolution, so the resolution is *absent*
  exactly when the long format name needs the width.

- **Memory and CPU on the status bar**, after what has been read and whether the
  file checks out. Per *browser tab* rather than per session, because the memory
  a gene model holds and the core a scan is burning are shared by every tab in
  the window.

  Both are weaker than what a task manager shows, and the tooltips say so
  outright. A page cannot see its own process — a precise figure would read
  across origins — so memory is the JavaScript heap and its ceiling where that
  is all Chromium offers, and the whole-agent measurement where a build is
  cross-origin isolated. CPU has no API at all, so it is measured from the
  inside: every thread in the tab times its own event loop, and the share of the
  last three seconds they could not answer in, summed against the machine's
  cores, is the number. Work too brief to delay anything never appears, so the
  reading is a floor rather than an estimate. The workers report their own, which
  is the point — a whole-genome scan pins a worker for minutes while the main
  thread sits idle.

- **Drop a file on the map itself to make it a track**, on the edge you aim at:
  a strip along its bottom for the horizontal stack, one down its side for the
  vertical one. Two rectangles appear while a drag carrying files is over it and
  are inert the rest of the time, because the map's own gestures — pan, the
  Option-drag selection, the click that opens a cell — live in the same pixels.
  What the file *is* is still decided by its bytes (§8.3): a `.cool` aimed at
  the bottom of the map is a map, not a track drawn along the bottom.

- **`/` puts the caret in the box, in every view.** It was the genome browser's
  alone, so the same key that found a gene did nothing the moment a `.cool` was
  dropped in the same tab. Each view now answers it with its own box: the region
  box on a region, the filter above a table, and a new one in the heading of the
  whole-genome, genome, pair and scan views — which is also the only way to
  leave those pictures by typing rather than by aiming, and a genome of one
  metagenome's four thousand is a quarter of a pixel to aim at. The key is
  printed in the box and steps out of the way when the caret arrives.

- **Every shortcut is on the button that performs it.** Tooltips name their key
  — the panel folds, the theme, the tab strip, both Plot cards, every overlay
  toggle, the breadcrumb's landing views — and the two `whole genome →` buttons
  and the breadcrumb menu print theirs as a badge. The bindings come from two
  tables (`ui/commands.ts` and `ui/plotOptions.ts`) that the key handler, the
  palette, the shortcuts dialog and every one of those tooltips now share, and a
  test asserts no two actions claim the same key.

- **A mark before every card title** in the three panels, so a column of five
  cards is recognised by shape before it is read.

- **A height for every track, and the button that gives it to them**, in the
  browser's Plot card beside the stretch mark. Stretching answers "use the space
  I have"; this answers "I know what a track should look like" — ninety pixels
  is where a yeast ATAC track starts showing the shape of a promoter — and it is
  also the way *out* of a stretch, which on a tall screen with two tracks leaves
  two four-hundred-pixel lanes and nothing to bring them down with. The box is a
  number and nothing happens as it is typed; Enter and the button are the
  instruction, so it keeps what you last applied and the next file is one press
  away from it.

- **Drag a track onto the other edge of the map to move it there.** The two
  rectangles that take a dropped file take a *loaded* track as well: pick a row
  up by its grip in the Tracks card, and both rectangles appear the moment it is
  over the map — drop on one and the track is drawn there instead.

  The gesture is on the row rather than on the lane's *body*, and that is the
  second attempt. Dragging the body is what a reader reaches for and there is no
  room for it there: a lane already answers three drags — its border resizes,
  along the axis pans, across reorders — so a fourth had to be read out of one
  of them, and the trip from the bottom stack to the right-hand rectangle is
  mostly sideways, which is a bottom lane's *pan*. It worked from one stack and
  fought the other. The row carries no such freight, and it is where the track's
  other settings are. (The lane got the gesture back in the end, on a handle of
  its own — see below.)

  A row now has a grip beside a map even when it is the only one, since there it
  has something to do besides reorder. The drag carries its own MIME type, so
  the rectangles can tell it from a dropped file and from a dragged word while
  the drag is still in the air, and the whole content area no longer lights up
  for it. It is the same state as the `location` setting on the row, because it
  is the same field.

- **`S` saves the plot.** Whichever view is mounted exports itself — the map or
  the browser — in the format and at the resolution its own Plot card is set to,
  because a shortcut that saved something other than the button beside it would
  be a second export to keep in step. It is one letter from `⌘S`, which saves
  the *session*, and that is the pairing: two things a reader means by "save
  this", told apart by the modifier. Stretching the tracks moves to `H`, for
  height.

- **`location`, in the row's settings, rather than `B`/`R` tick boxes on its
  head.** Two buttons with the words on them — `bottom` and `right`, and not a
  choice between each other, since a track can be on both — drawn as one
  segmented control below `height`. The initials were standing furniture in
  six-point type between a track's name and its eye, for a decision taken once
  per track and now also takeable by dragging the lane itself. The last edge a
  track is on cannot be switched off: a lane on neither edge is drawn nowhere
  while still calling itself visible, and the eye beside the name is what hides
  a track.

- **The drop zone is what lights up**, not the card around it. A card that asks
  for a file still takes one anywhere on it — a reader whose pointer is over the
  eighth row when they let go meant to load it — but what reacts is the dashed
  box, which is the element already drawn as the target. The whole card going
  blue around an inert rectangle said the rectangle was not the one. Tracks,
  Compare and the browser's Contact map card all behave this way now, and a
  *row* dragged within the Tracks card lights nothing, because a drag carrying
  no files is a reorder.

- **Plot before Groups** in the browser's Aesthetics column. Plot acts on this
  picture and is there whatever the file is; Groups is empty until a reader has
  made one, and a column that opens with an empty card reads as a column with
  nothing in it. The browser's toolbar also gives up its autoscale button, which
  was the sixth control in a row that then wrapped, orphaning one button on a
  line of its own — it is in the Plot card, on `Y`, where the height box is.

- **A track lands under the map, not beside it.** The bottom edge is where a
  track is read — under a ruler, left to right — and a coverage profile turned
  on its side has to be read with your head tilted. The right-hand stack is
  still there and is now something you choose: the `B`/`R` boxes on the row, or
  the edge you drop the file on.

- **`S` stretches the tracks** to fill the height, all of them to one height,
  which is the thing a reader reaches for several times a session. Autoscale,
  which had `S`, is now `Y` — the axis it acts on — and works beside a map as
  well as under a browser, since they are the same tracks in the same store.

- **The status bar is one line, always.** It is the bottom edge every view is
  measured against, and it grew a second line exactly when the pointer was over
  a stack of tracks — when the reader is least interested in it. So `read` is
  bytes and keeps the request count in the panel it already opens on hover,
  `memory` is bytes and keeps the share of the ceiling there too, and the
  coordinate readout is the item that gives way, being the one thing here that
  is re-said a moment later.

- **The standing `read in place · nothing is sent` line is gone from the bar.**
  The claim is not: the picker states it where a file is about to be opened, and
  About states it in full. It was a sentence you finish reading once, permanently
  occupying a corner of a bar whose other three items are numbers that change.

- **The shortcuts dialog has no Help group**, so the two gesture tables — what a
  drag, a wheel and a double click do on a map, against what they do on the
  tracks — sit side by side, which is how they are read. `⌘/` was the only bound
  command in Help and is now beside the palette in App, where it belongs. Both
  tables also gained the gestures they had been missing: the lane resize, the
  edge drops, and dropping a file on the browser's tracks.

- **The Compare card and the browser's Contact map card wear the Tracks card's
  load zone** — a thin unshaded box with a bold line and a quiet one, then the
  URL behind a fold. All three ask the reader for a file, and three shaded
  variations of one gesture in one column read as three applications. The
  Contact map card can now take a URL, which it could not before.

- **One box in the browser's toolbar**, not two. `chrIV:1,000-2,000`, `chrIV`
  and `GAL4` are three spellings of "where do I want to be", and asking which of
  two boxes each spelling belonged in was a taxonomy the reader had to learn in
  order to type a word. Coordinates win when the text is coordinates; anything
  else falls to the list of names under the box. Clicking it selects what is
  there, because what is there is where you already are, and `/` still lands in
  it.

- **Loading a track is at the top of the Tracks card**, rather than in a card of
  its own below it. The two questions are asked of the same thing, and with
  eight tracks loaded the way to load a ninth was to scroll past the eight.

- The app was one object holding a worker, a store, a file and a view, and it
  bound itself to the address bar in its constructor. It is now `app/Session.ts`
  — a file and the views of it — and `app/App.ts` — the window around them —
  with `main.ts` as three lines of bootstrap. `ViewStore` stops owning the hash,
  because there is one address bar and there may be six stores.

- The sample cache that keeps pan and zoom free of I/O moved out of
  `AnnotationLanes` into `annotations/samples.ts`. Two widgets need that rule now
  and its arithmetic — the padded window, the power-of-two bucket, keeping the
  old data on screen until the new data lands — is fiddly enough that two copies
  would drift.

- A `chrom.sizes` dropped on a browser whose lengths were *inferred* replaces
  them, and replaces only them: the URI, the session memory and every loaded
  track stay exactly as they were, because the genome did not change — only what
  is known about it. A `samtools faidx` `.fai` counts as one, decided by its
  name, which is the tiebreak `sniffFormat` already uses for the two cases its
  columns cannot settle.

- The colour swatch beside a track's name in the Annotations panel appears when
  the row is pointed at or has the focus, like the drag handle it sits next to.
  A column of coloured squares down the panel is a second legend for something
  the picture already says where it matters — the lane is drawn in that colour,
  and where two share a lane so is each name. It keeps its space while it is
  invisible, so reaching for it is one movement rather than a hunt.

- **Every lane has a grip, in both views.** Six dots beside the track's own
  name — the same glyph the Tracks card puts at the head of every row, because
  it is the same gesture on the same thing. Dragging it moves the track through
  the stack; beside a map, dragging it out onto either rectangle draws the track
  on that edge instead. Reordering a track was something you could only do to
  the picture from the *list* beside it, or by learning that a drag across a
  lane means one thing and along it means another.

  It is a fourth *surface* rather than a fourth reading of one, which is what
  makes it possible at all: a press that starts on the handle is not ambiguous
  in any direction, so it can mean "move this track" everywhere the pointer
  goes, and the three drags the lane's body already answers keep their pixels
  untouched. Drawn on the canvas rather than laid over it, for the reason every
  affordance here is: the pointer is an arrowhead pointing at a base pair, and a
  handle that lived in the cursor would not exist until you were on it. It takes
  the open hand as its cursor — the one thing the arrowhead cannot say — and is
  never on a saved figure, because what a reader points at is not part of the
  picture.

  **It is the only way to move a track.** The lane's body used to reorder as
  well, by reading the direction of the first movement — along the axis a pan,
  across it a reorder. Two meanings for one surface is a rule you have to know
  before your first drag does what you meant, and it was paid for on every pan
  that wandered a few pixels off the horizontal: the track jumped a slot,
  because a gesture that has to be performed *carefully* had been asked for.
  With a surface of its own for moving, the body goes back to meaning one thing.

  It hangs **outside** its lane, in the margin just before the data starts, and
  that is what lets every lane show one at all times. Inside, it had to be paid
  for twice: a slot cut out of the front of each label, which moved every track
  name along, and a glyph that could only appear on hover — because a permanent
  one would have been sitting on the signal. Outside, it costs the picture
  nothing, so the names went back against the start of their own track and the
  handles stopped being something to discover. Each one is on its name's line
  and keeps its distance from it, wherever the layout put that name: at the top
  over the data, centred in a column, down at the floor on a flipped track. The
  faint one is a handle; the solid one is the lane the pointer is on.

  The 1D browser keeps a thirteen-pixel strip at its left for them, since
  outside its first lane is off the edge of the canvas otherwise. Beside a map
  no strip is needed — the plot's own margin is where they go. Which end of a
  lane that is depends on which way the lane reads: the left of a bottom lane,
  and the *bottom* of a right-hand one, which turns a quarter turn and reads
  upward from there. A handle at the far end of a track from its own name is a
  handle belonging to nothing in particular.

  A grip drag raises the **other** edge's rectangle and only that one. A track
  taken out of the bottom stack cannot be moved to the bottom — it is already
  there — so offering it that target is offering a gesture with no outcome, and
  a rectangle that lights under the pointer and then does nothing when you let
  go reads as the drag having failed. The rectangle that is not offered is not a
  drop target either, decided in one place, so what lights up and what lands
  cannot disagree. A file dragged in from the desktop still gets both, since it
  is on neither edge yet.

  The right-hand stack makes its own room. Its handles hang past the end of the
  data, where the space available is whatever the heatmap left under its plot —
  a couple of pixels in a view with no column labels — so rather than back the
  handle into the signal, the stack adds the few pixels it is short to the end
  of its own canvas. After the data, so no coordinate moves and the map is not
  touched, and only when the margin is not already enough.

- **Loop anchors moved off the last track.** The triangle that says "this
  coordinate" was drawn over the last seven pixels of the last lane in the
  stack — on a coverage track that is the busiest part of it, and on a full one
  the mark is invisible. It now has a band of its own past the stack, on both
  edges, which is the only place a glyph about the axis can go without being ink
  on somebody's data. The band is nine pixels and exists only while a loop is
  marked, so a session that never places one keeps those pixels for the map.

- **The map's two drop rectangles moved inside the map, and became strips.**
  They covered the bottom quarter and the right fifth of the whole plot area —
  which is where the lane stacks are — so a track dragged towards the end of its
  own stack met a drop target instead of the gap it was aiming for, and the last
  slot in the order could not be reached at all. Inside the map they overlap
  nothing that can be dragged, and they still name the edge they stand for: the
  bottom of the picture means below it, the right of the picture means beside
  it.

  Narrow, too, and **centred on the edge they name**: thirty pixels thick, four
  fifths of the map long, each in the middle of its own side. A quarter of the
  map's height and a fifth of its width is a lot of a picture to cover in order
  to say "this edge", and at that size the two rectangles hid the corner of the
  matrix a reader is usually aiming past on the way to them. Centring at four
  fifths is also what keeps them apart — each stops a tenth of the map short of
  the corner they share — so a drop in the corner lands on neither, which is the
  honest answer to a gesture aimed between two targets. Down the side the label
  turns the same quarter turn as the track names in the stack it is naming. All three
  gestures that aim at them — a file from the desktop, a row from the Tracks
  card, a lane by its handle — now arm them, and while a lane is being carried
  the tooltip stays down rather than following the pointer across the map with a
  reading from where the drag started.

### Fixed

- **The service worker would have answered a pinned URL with the newest build.**
  It is registered at the site root, so every archived build's address is inside
  its scope, and its navigation handler answered *everything* in scope from the
  precached shell — the right URL, the wrong code, and no symptom to notice it
  by. Navigations under `<scope>v/` now go to the network untouched.

  A worker only updates when a page it controls is loaded, so the fix cannot
  reach a reader who is already carrying an older one — and that reader is
  exactly who follows a pinned link. `recoverPinnedNavigation()` catches the
  case from the page itself: a document built for the site root, at an address
  under the archive prefix, is a pair of facts that cannot both be true of a
  correctly served page. It unregisters and reloads, once per tab, because the
  second attempt at that would be a reload loop.

- **A cooler rendered nothing.** `MatrixPanel`'s new edge-drop watcher read
  `this.el` from the constructor, where it does not exist yet, so the panel threw
  on the way up — for every file that *has* annotations, which is every cooler,
  while a `.metacool` (which has none, §8.5) was unaffected. Clicking a contig or
  opening the whole-genome view produced no map at all. The listeners go on the
  grid instead, which exists by then and is the honest scope anyway: it holds the
  map, its lanes and the two zones, while `this.el` reaches the colourbar and the
  header, where a drag means nothing.

  It survived a type check, 697 unit tests and a code read, because none of them
  run the constructor. What catches this class of defect is opening the app, so
  the working file now gets opened: a genuine `.cool` built by the public cooler
  API, served over range requests, driven through the contigs table, the
  whole-genome view, a region, and a browser session with a track in it.

- **The labels overlay could not be toggled in a genome browser session.** `L`
  was bound twice — the overlay, and "go to a locus" — and the command list is
  searched in order, so in a browser the locus box always won. The browser has
  one box that is both a locus bar and a search field, and it now has one key
  for it (`/`), which is the key every other view answers too.

- The icon generator dropped every SVG attribute whose name contained a digit,
  so every `<line>` was emitted with no coordinates and drew nothing. It had
  been latent because no icon used one; the magnifiers added here came out as
  bare circles.

- A lane's hover controls took presses while they were invisible. `opacity: 0`
  hides a control but does not stop it being clicked, so every track carried a
  band across it — three hundred pixels wide and thirty tall — where a drag
  started on a `<select>` and the view silently refused to pan. They are now
  transparent to the pointer until the lane they belong to is the one being
  pointed at, and the pointer moving onto them no longer counts as leaving the
  view: without that the row goes untouchable, the pointer lands back on the
  canvas, the row is revealed again, and the control under the hand is never
  there long enough to be clicked.

- "Fit tracks to the space" measured the element it was about to resize, which
  is sized by its own contents — so it compared the tracks against themselves,
  found them already fitted, and did nothing at all. It now measures the column
  the view was mounted in, walking past the `display: contents` wrapper that
  gives a session's panels to the shell's grid and reports every rectangle as
  zero.

- Every control that appears on hover — a tab's ×, a track's colour swatch — is
  now inert while it is invisible, and shown outright where there is no pointer
  to hover with (`@media (hover: none)`). Both halves matter: `opacity: 0` hides
  a button and does not stop it taking a click, and a control revealed by
  pointing is a control that appears never on a touch screen. Each appears with
  no transition and fades only on the way out, so there is no moment in which
  one is clickable and barely drawn.

- Moving the caret from one lane's limit straight to another's kept the first
  number. The press that lands on a second limit is handled on `pointerdown` and
  calls `preventDefault`, so it never produces the focus change that would have
  committed the first — and the editor was being *cancelled* on the way out. The
  natural gesture for setting the same bound on two tracks was therefore the one
  gesture that silently threw the first value away, while clicking anywhere else
  on the canvas committed it.

- With the words switched off, the lane's two limit boxes were seeded once and
  never refreshed, and committing either one wrote *both* — so typing a floor
  republished whatever ceiling the row happened to be built with, silently
  undoing a zoom or a drag of the ceiling slider. Each box now commits its own
  bound and takes the other from the axis on screen, exactly as the drawn range
  does, and the untouched box follows the lane it is beside.

- Choosing PNG collapsed the export row: the resolution select inherits
  `width: 100%` from the controls card, and a `flex-basis: auto` resolves to it,
  so a control that must not shrink claimed the whole line — crushing the format
  select to nothing and pushing Save off the card.

- A click in the Sequences card now moves the view directly rather than through
  the view state. A patch that serialises to what is already stored is dropped
  without notifying, so clicking the sequence the hash already named could do
  nothing at all.

- `fmt.int` groups digits in the *viewer's* locale, and half of Europe groups
  them with a space WinAnsi has no byte for — so a figure exported in French
  read `7?071 in view`, every grouped number corrupted by the app's own
  formatter, in the one place nobody would look for a locale bug. Those spaces
  now fold onto the non-breaking space WinAnsi does have.

- Ticking a track did not open the batch bar until the focus left the list. The
  rebuild is deferred while a control in the list is being edited — a colour
  picker closes and a half-typed name is lost otherwise — and a checkbox was
  being counted as one, which deferred the very rebuild the tick was asking
  for. It commits on the click that focuses it, so there is nothing to protect;
  the focus is put back on the same box afterwards, so a second tick needs no
  second aim.

## [0.5.1] - 2026-08-04

### Fixed

- Fixed unit tests that errored on Github runners without fixtures.

## [0.5.0] - 2026-08-04

### Added

- **Right-click the map to mark the cell under the pointer.** Vertical line,
  horizontal line, crosshair, loop — each row showing the coordinate it would
  use, so what is about to be marked is visible before it is — and copy
  coordinates. The two ways in that existed were typing a coordinate you already
  know and arming a mode and clicking; neither answers "this one, the one I am
  pointing at".

- **Lanes beside the map are draggable, and carry their own menu.** The border
  resizes a track, the body reorders the stack, and dragging *along* the axis
  still pans the map — which it has to, since that is what dragging a track has
  always done. The direction of the first movement tells the three apart, so
  nothing needs a modifier key and no gesture was given up for another. A right
  click on a lane offers its colour, its range, hide and remove: the two
  controls a reader beside the map actually reaches for, where the track is
  rather than across the window in a card.

- **Hand-drawn lines are continued into the lanes.** A vertical rule is a column
  and is drawn under the map; a horizontal one is a row and is drawn beside it;
  a crosshair is both. Loop anchors are small triangles on each stack's outer
  edge, pointing back at the map. A mark called out on the matrix is a
  coordinate, and the tracks beside it are what a coordinate is usually being
  compared against — the marks were on the map alone, which is where the
  comparison could not be made.

- **Tick any number of genomes or sequences and see them as one map.** Each on
  the diagonal and every block between them off it — the picture the pair view
  showed for exactly two, without the two diagonals that make an off-diagonal
  block readable. Both tables carry checkboxes now, with "select all" over
  whatever the filters leave visible (filter to completeness above 90, then take
  all of them) and "clear"; the button names two and counts more, because
  `MAG_7 × MAG_12 →` is worth more than a number and four names are longer than
  a button.

  It is a view state — `view=selection&genomes=a,b,c`, or `regions=` for
  sequences — so a selection is a link, a history entry and a back button, and
  `genomes=a,b` is precisely what `view=pair` used to be. The pair view stays
  where it is: the overview's cross-genome clicks lead there and so do links
  already sent.

  The read is the whole-file scan with most of the file left out. A selection is
  scattered through the pixels, so there is no shorter span to walk — the gate
  says so, and the progress bar and cancel are the ones the whole-genome read
  just gained. The axis is built from the selection in *file* order rather than
  the order it was ticked in, because a matrix whose rows jump about is a
  picture of the clicking; it is pooled against its own size, so four MAGs are
  drawn at four MAGs' resolution however large the file they came from is; and a
  genome resolves to its contigs, so ticking four MAGs and ticking their contigs
  are the same map. Checked on every fixture against the same oracle the pooled
  read uses: a scattered selection equals the dense block rolled up over the
  same grouping, cell for cell.

- **The app says what it is on the way in.** The mark — the same drawing as the
  favicon, the install prompt and the dock icon — is now a masthead on the
  landing page: mark and name on one line, centred, spanning 80% of the drop
  zone below them, with the tagline under and 20 px of air above. Both are
  scaled by one `clamp`ed font size, so the pair stays one thing from a phone to
  a wide window. In the header
  it sits at 26 px before the name, sharing its centre — the brand row was
  baseline-aligned, and an image's baseline is its bottom edge, so the mark hung
  visibly high against the words. The first screen used to open on an
  instruction, which made it a dialog rather than a page. It is read from the
  192 px file `npm run icons:app` already writes, not a fifth copy of the shapes.

- **"whole genome →" in the genomes and chromosomes tables.** The whole-file view
  was reachable from the chevron beside the root crumb and nowhere else, which is
  a corner of the window to find something the table in front of you is the
  question about. The metacool gets its scan, the cooler its map; the button is
  absent on a metacool's per-genome contigs table, where "the whole file" is not
  what is being asked.

- **The cooler's whole-genome read has a progress bar and a cancel**, the same
  two the whole-metagenome scan has always had — it is the same pass over every
  pixel of the same file, and the difference was in the plumbing rather than in
  the wait. What made it possible is the reader walking a span *asynchronously*:
  a cancel arrives as a message, and a synchronous loop never lets the message
  queue run however many microtasks it awaits, so a read that could take twenty
  seconds could not be called off and could not say how far along it was. The
  contig roll-up is watched the same way, since it walks the same pixels.

- **Hand-drawn marks can be saved.** The Manual annotations card grows the export
  row the Aesthetics panel has — a format, and a Save — writing lines as BED and
  loops as BEDPE, one base wide and half-open. Both come back through this app's
  own sniffer and parsers as an overlay on the map, which is the property
  `manual-export.test.ts` checks rather than the text; and both are what bedtools
  reads, because a coordinate someone chose outlives the session they chose it
  in. Nothing to write is a disabled button rather than an empty file.

- **The whole-genome view of a cooler is read at the resolution it is drawn at,
  and there is no longer a file size that defeats it.** It used to ask for one
  cell per file bin, which at 24,228 bins is 2.3 GB of values in one array — and
  a browser serves at most 2 GiB in one, whatever the machine has, so a whole
  yeast genome at 500 bp was offered, computed for several seconds, and then
  refused. The picture it was refused for was one nothing could have shown: the
  renderer pools any raster to 4,096 px per axis, so those 24,228 rows were
  always going to be drawn as about 4,000 pixels.

  So the pooling moved to the read. Every `stride` consecutive bins of a
  chromosome are summed into one cell, in the worker, straight from the stored
  pixels — the block that arrives is the one that was always going to be drawn.
  Yeast at 500 bp is 4,047 cells and 66 MB instead of 24,228 and 2.3 GB; at
  200 bp, where the dense block would have been 14.7 GB, it is the same 66 MB.
  A human cooler at 10 kb, 381.9 GB dense, is 67 MB and 760 kb cells. The read
  is bounded by construction at every bin size a file can have.

  **What arrives is an ordinary block one bin size up**, not a new kind of
  object: the stride restarts at every chromosome, so a cell is `stride` bins of
  one sequence and a run of cells is that sequence. The panel is told the coarser
  bin size and every coordinate, tick, tooltip, region box and figure caption is
  then right without knowing pooling happened — a box drawn on the 3 kb overview
  still opens that region at the file's own 500 bp. It is the relationship an
  `.mcool`'s 5 kb level has to its 1 kb level, computed on the way through rather
  than stored, and the sums are identical to `metacooler aggregate` over the same
  squares (`pooling.test.ts` checks every fixture, cell for cell, against the
  dense read rolled up by the existing folded aggregation).

  What the view still costs is the pass over the stored pixels, which is what it
  always cost, and that is now what it asks about: above ten million pixels the
  map waits behind a button that states how many there are and what resolution
  they will be summed into. Below it nothing is asked. The whole-metagenome scan
  is gated for that same reason, and the two views now behave alike down to the
  wording.

- **Both whole-file views are kept across navigation.** They are the expensive
  reads, so the shell holds whichever one it built, keyed on what was read (uri,
  level, balance): leaving one for a chromosome and coming back returns to the
  picture rather than to the gate. Changing the level or the balance is a
  different read, so that one is rebuilt and the old block released rather than
  left in memory unread.

### Removed

- **Captions on hand-drawn marks.** A text box under every mark, for a sentence
  the figure already makes. Gone from the card, from the model and from the
  drawing — and with it the label helper, the halo it needed and the type size it
  was written at.

### Fixed

- **A right-click on the map no longer navigates.** `mousedown` fires for every
  button, and the map's press/release pair had no guard, so a right-press was
  answered as a click on release: right-clicking a whole-genome view opened
  whatever cell was under the pointer, and the menu the press was for arrived
  over the view it had just left. The primary button only, now — and the same
  guard on the side panels' drag handle, where a right-press armed a resize the
  browser's own menu then sat on top of.

- **Both ends of a loop are marked on both 1D axes.** A loop is a statement
  about two loci, and a reader looking at the tracks under one end of it is
  asking what is at the other. Drawing the row anchor only beside the map and
  the column anchor only under it answered half of that on each edge, and
  neither half where the comparison is made.

- **The masthead's mark sits on the word's centre line.** Centring the two boxes
  left it visibly high: a line box carries the font's ascent and descent, so the
  ink of a word sits below the middle of its box while a square's ink is its
  box. Measured on the rendered pixels — 10.5 px of offset at a 97.6 px font —
  and corrected in `em`, so it holds at every size the `clamp` produces.

- **A block too large for one typed array says which limit it hit.** A browser
  serves at most 2 GiB in a single `Float32Array` whatever the machine has:
  measured in Chrome on a 16 GB Mac, 2,140,000,000 bytes is served, `2**31 - 4`
  is not, and four separate 1 GB arrays live side by side. It is a limit on one
  array, not on the tab, and the refusal used to blame "this machine".

  It is now checked ahead of the memory budget and cannot be overridden by a
  confirmation, because there is nothing to override; the message names the
  largest square block that can be made (about 23,170 × 23,170 bins) and the ways
  through. The whole-genome view no longer reaches it at all — it reads pooled —
  so what it governs now is a region, a genome or a pair.

  A test asserted that yeast at 500 bp loads densely, and was passing, because it
  exercised the *estimate* and the estimate never tried to allocate anything.

- **The Annotations panel scrolls as a whole, not card by card.** Twelve little
  scrollbars where the reader wanted one. `overflow-x: auto` was set on the cards
  so a wide one could scroll sideways inside a narrow column — but a box with
  `overflow-x: auto` and `overflow-y: visible` is not a thing CSS has: the
  visible half computes to `auto`, so every card was a scroll container in both
  directions, and a flex item shrinks by default, so each one was squeezed and
  scrolled inside itself the moment the panel was full. `flex: 0 0 auto` on the
  cards is the whole fix. `.side` keeps the opposite behaviour deliberately: a
  view's sidebar fills the column so its contig list can scroll where it is.

- **Less white between a key and its value in the File card.** The key column was
  a fixed 9rem, set when values were elided and had to start at a predictable
  place. They run to their full width now, so there is nothing to line up with,
  and the column takes what its longest key needs.

- **More room before any of that.** The memory budget is now half of what the
  device claims rather than a third, and the assumed memory where the browser
  says nothing — Firefox and Safari, on every machine — is 8 GiB rather than 4.
  A 20,000-bin block, 1.9 GB, was refused outright on both of those engines and
  now loads. Guessing high costs nothing since the allocation itself is caught
  and translated; guessing low was costing pictures the machine could draw.

- **The whole-metagenome view is a view state, not a mode the shell holds.** It
  was the only landing view of a file with no link, no history entry and no back
  button — pick it and the URL did not move, so it could not be shared, and
  reloading landed on the genomes table. It is `view=overview` now, a peer of
  the two tables it shares the root menu with, and everything that follows from
  that follows: the level and the colour scale are in the hash like every other
  view's, the back button leaves it, and the plot re-measures when a side panel
  is dragged — which, being mounted outside the shell's own view slot, it did
  not.

- **The three panels resize — which, despite 0.4.0, is the first time.** The
  drag handle, the remembered width and the double-click reset all shipped, and
  none of them could be reached: the handle was a sticky flex item at the end of
  a column that was already full, so it was laid out *below* the fold, and
  `sticky` only holds an element that scrolling would carry away — it never
  pulls one up into view. The negative margin meant to cancel its height could
  not, because a percentage margin resolves against the containing block's
  width whatever axis it is on. So the strip was real, painted, and permanently
  out of sight.

  It is now positioned against the column, and the column no longer scrolls:
  its body does. The heading staying put while the cards move under it is the
  same change seen from the front.

### Changed

- **Saving a figure is one row: resolution, format, Save.** It was a DPI
  dropdown, then a line of two buttons labelled `PNG` and `PDF`, two rows
  further down — which made the choice of file into the action itself and left
  the resolution stranded above the thing it applied to. Now the row reads the
  way the sentence does: 300 dpi, PDF, Save. Both defaults are unchanged; PDF
  simply stops being the second button and becomes the one that is already
  chosen.

- **Cards in General scroll sideways rather than eliding or wrapping.** A URI
  cut off at `Hum66.met…` and a genome name broken across three lines are the
  same failure: this panel is where you go to read the identity of what is on
  screen, and an identity you cannot read whole is not one. Keys and values now
  keep to a single line and the card scrolls under them. Hovering still gives
  the full text, for the reader who would rather not.

## [0.4.1] - 2026-08-04

### Changed

- **A real app icon, dark, everywhere an icon appears.** The mark is the thing
  the viewer draws — a block-diagonal contact map, three genomes on the
  diagonal and two long-range contacts off it — on a macOS-style plate. It
  replaces the flat blue square with two white blocks, and it is now one
  drawing rather than two: `scripts/make-app-icons.py` renders the browser tab
  favicon, the install prompt's 192 and 512, a new `apple-touch-icon.png` for
  the iOS home screen, and the 1024 square electron-builder derives every
  macOS, Windows and Linux icon from. The favicon is written into `index.html`
  by the same script, from the same constants, so the tab icon and the dock
  icon cannot drift apart the way the two hand-kept drawings could.

  The dark variant is the one that ships at every size. The light one is still
  drawn, into an ignored `out/`, so the mark exists in both values — but
  nothing in the build reads it.

  The plate's edge is now a ring band — the difference of two squircles, filled
  with a vertical gradient — rather than a stroked outline clipped back to the
  silhouette. The old way drew the border at full strength and then threw most
  of it away in the compositing, against a mask whose own edge is antialiased,
  which is why the light plate had a border only in the sense that something
  was there. Each variant now names a `rim` and a `bevel`: the light plate gets
  a warm dark hairline with a white highlight inside it, the dark plate the
  white hairline it already had, crisper.

- **The Linux window carries the icon too.** electron-builder installs the
  launcher entry and the hicolor ladder, but the window itself is drawn from
  what the process declares, so the taskbar and the alt-tab switcher showed the
  default Electron icon. `build/icon.png` now ships beside the asar as an extra
  resource and `BrowserWindow` names it. No change on macOS or Windows, where
  the bundle and the `.exe` already answer that question.

### Removed

- `scripts/make-app-icons.mjs`, superseded by `scripts/make-app-icons.py`. It
  wrote the same three files, so leaving it would have meant one `npm run
  icons:app` away from silently reinstating the old mark. `icons:app` now runs
  the Python script and takes `METACOOLER_PYTHON` the way `fixtures` does; it
  needs `pillow` and `numpy`, and the icons it draws stay committed, so no
  clone and no CI runner has to have either.

## [0.4.0] - 2026-08-04

### Added

- **Three named panels — General, Annotations, Aesthetics — all foldable and all
  resizable.** They had grown into three unrelated things: a sidebar with a fold
  button, a column added beside it with a fold button copied from it, and a
  controls column with no button and no name at all. They are the same object, so
  they are now one; what differs is a name, a side and a default width. Drag a
  panel's inner edge to resize it, double-click the edge to reset it, and both
  the width and the fold are remembered. <kbd>b</kbd>, <kbd>a</kbd> and
  <kbd>m</kbd> fold them. A card too wide for the column it is in scrolls inside
  it rather than spilling out of it.

- **The tracks pan and zoom the map.** A lane is a picture of the same window the
  map shows, drawn through the same scales, so dragging one and dragging the map
  are the same gesture on the same data — and a track you could read but not move
  was an exception a reader had to discover. Dragging a bottom lane scrolls the
  columns, dragging a right lane scrolls the rows, and a wheel over either zooms
  exactly as a wheel over the map does. The lanes carry the map's arrowhead
  cursor for the same reason.

- **An annotations panel of its own**, between the file sidebar and the map. The
  three annotation cards used to live in the file sidebar, folded in under the
  record card, and shared its scroll box: a growing list of tracks bought its
  height by pushing the file's own identity off the top of the screen, and
  folding the sidebar to get the room back took the annotations with it. They
  are now a column with its own fold (a `layers` button beside the sidebar's, or
  <kbd>a</kbd>) and its own scroll. The two left columns are ordered outward from
  the map by how often they are touched.

- **The colour and the name are edited where they are shown.** Clicking the
  swatch in a row opens the colour picker; clicking the name edits it in place.
  Both were fields behind the settings disclosure, which made the two commonest
  changes to an annotation among the most expensive. They are no longer offered
  in the settings, because they are no longer hidden.

- **Rows can be reordered**, by dragging the grip or by focusing it and pressing
  the arrow keys. The order is the order the lanes are stacked in beside the map,
  so this replaces removing three tracks and dropping them again in the order you
  wanted.

- **One hairline, and every value at once, when you point at a track.** Hovering
  a lane draws a single line — not a crosshair — across the lane stack and the
  map, at the position under the pointer, and the tooltip reads out *every* value
  track on that edge at that position rather than only the lane being pointed at.
  The lane the pointer is in is marked. A gene or peak under the pointer is
  described underneath.

- **Placing marks by clicking the map is a mode**, not a single shot. "Pick on
  map" stays on and becomes **Done**; every click places a mark until Done or
  <kbd>Esc</kbd>. Marking up a figure is eight gestures, not one, and the trip
  back to the sidebar between each was the whole cost of the feature.

- **Autoscale groups are a picker.** A group is only a group once two tracks are
  in it, so the second track has to be given the *same* name as the first — and
  the free-text box gave no way to find out what that was. A misremembered name
  raised nothing; it quietly made a group of one. The list is now the memory, and
  `new group…` is where a name is coined.

### Changed

- **The centre column stays light in the dark theme.** A contact map is a
  *figure*: its colormaps are built for ink on white, its labels and frame are
  drawn in the greys `ops/show.py` uses, and what leaves as a PNG or a PDF is
  light whatever the screen was. Letting the theme through meant the picture on
  screen was not the picture exported — and the halo behind every label, which is
  the page background, turned black behind dark grey text on a white plot.
  Everything around it — header, panels, status bar — is dark as before.

- **The lane tooltip names the position, not the lane.** The lane is the one the
  pointer is on, which the pointer already says and the marked row repeats; the
  heading is now the coordinate alone. Values read `name: number`.

- **The `auto` limit is a button**, bordered while it is on, rather than a tick
  box — and typing either bound turns it off, which is the only thing typing a
  bound can mean. The tick box was a third control on a row that already held two
  number boxes, and it took the width that made them overflow their card.

- **The annotation cards have lost their subtitles.** Each drop area under the
  heading already says what it takes and how it is drawn.

- **A new annotation is drawn on the right edge**, not the bottom. The bottom
  already carries the coordinate axis, the block labels and the colourbar
  caption, and a stack of tracks there pushes the map up the page; the space
  beside it is empty in every view. Both tick boxes still work as before.

- **Lane height is typed in pixels**, with the drawing style beside it, in place
  of a slider. A slider is for a quantity with no natural unit, and this one has
  the most natural unit there is.

- **Track limits are trimmed** the way the colour clip's boxes already were, and
  capped at three decimals. A bigWig header stores `float32`, so the faithful
  seed for a limit was `0.03999999910593033`.

- **Loop calls are ringed once**, on the upper side of the diagonal, instead of
  on both. The matrix is symmetric, so ringing both said the same thing twice —
  and on a set of any size the second ring was a few hundred circles the reader
  has to check against the diagonal to know they are not a second set. A view
  whose two axes are different blocks still shows the one placement it can.

- **A track's summary no longer counts the file's zoom levels.** That is a fact
  about how the bigWig was built rather than about what is in it, and it pushed
  the value range — the number a reader can act on — onto a second line.

### Removed

- **The per-track `linear`/`log2` scaling option.** It was a dropdown whose
  effect on a lane forty pixels tall was hard to read and easy to forget having
  set, and it put a lane on a different value axis from the one beside it, which
  is the opposite of what the autoscale group next to it is for. A ratio that
  wants a log axis is better written that way by the tool that made the bigWig,
  where the axis label can say so. A stored session that had `log2` set comes
  back linear.

### Fixed

- **The colourbar no longer disappears when tracks are shown.** Assigning
  `canvas.width` clears a canvas, and the legend's redraw was guarded on the
  colour *scale* having changed — which a resize does not change. Adding a track
  was enough to trigger it: the lanes relayout the plot, the resize observer
  fires, the bar is cleared, the guard says the scale is the same, and the legend
  is gone for as long as the view lasts. The invariant now lives inside `resize`,
  where a third caller cannot forget it.

- **A right-hand lane stack no longer overflows the column it is in.** The map's
  height budget accounted for the tracks stacked *under* it but its width
  accounted for nothing stacked *beside* it, so nine tracks on the right edge ran
  out under the view controls — where the far half of the stack was not merely
  off-screen but could not be hovered at all. Unreachable before this release
  because the bottom edge was the default; the default is now the right one.

## [0.3.0] - 2026-08-04

### Added

- **Tracks and annotations, on cool and mcool files.** Three cards in the left
  sidebar, and everything they draw. See [SPECS §8](SPECS.md#8-tracks-and-annotations).

  **Linear annotations** takes one GTF or GFF gene model, any number of bigWig
  tracks, and any number of BED-like segment files (BED 3–12, narrowPeak,
  broadPeak). Each is drawn beside the map on the bottom edge, the right edge or
  both, with its own colour, height, style (line, area or bars), value scaling
  (linear or log2), and limits — auto, which rescales to what is on screen, or a
  pair of numbers. Tracks that share an autoscale **group** resolve to one range
  over everything they show, which is the only way two of them can be compared
  by eye.

  **Map overlays** takes BED-like files as marks on the diagonal — a box for an
  extent, a mark across the diagonal for a point call, which is the only shape
  that survives being zoomed out — and BEDPE-like files as circles off it. A
  headed table with `chrom1/start1/end1/chrom2/start2/end2` counts as BEDPE,
  because that is what loop callers actually emit.

  **Manual annotations** takes vertical, horizontal and crossed lines, and
  arrowheads on or off the diagonal. Both are entered as coordinates or placed
  by clicking the plot, and both are stored in base pairs, so they survive a
  zoom, a pan and a change of resolution in an `.mcool`.

  Nothing drawn on the map fills the pixel it is about: loops are open circles,
  domains are outlines, and the arrowhead sits *outside* the cell it points at,
  on the far side from the diagonal — mirrored below it, so a mark placed while
  reading the upper triangle never points into the map from the lower one.

  Everything stays locked to the matrix because it is drawn through the matrix's
  own coordinate scales; nothing here computes a second mapping. Panning and
  zooming perform **no I/O**, as they already did for the map: a track fetches a
  window half again as wide as the view at a resolution rounded to a power of
  two, and everything inside that redraws from memory. Zooming out averages
  through bigWig's own zoom levels, and a feature lane with more features than
  pixels switches to a density profile rather than painting a solid bar. Hovering
  a lane names the feature or reads out the value; the crosshair continues from
  the map into every lane; exported PNGs and PDFs carry the lanes, redrawn at
  the export resolution.

  Contig names are checked on load and the overlap is always reported, in both
  directions — a GTF using `chrI` against a map using `I` is the most likely
  support question there is, and it presents as a broken feature rather than as
  two files disagreeing.

  Restricted to cool and mcool. On a `.metacool` the cards are **absent**, not
  disabled: a metagenome's axis is contigs from thousands of independently
  assembled organisms, so a file keyed on contig names either coincides with it
  or misleads.

- **One click loads the ten tracks published beside the yeast micro-C map.**
  Gene models, MNase, ATAC, Pol II ChIP-over-input, stranded RNA-seq, shotgun
  coverage, two peak sets and the loop calls — all on that map's own assembly.
  Offered only when the map itself came from a URL, never for a local file that
  happens to share the name.

- **The tooltip says how far apart a contact is.** Hover an off-diagonal cell
  within one chromosome or contig and it now reports the genomic distance
  between its two ends, which is the number a Hi-C map is actually read by. It
  is deliberately absent where there is no answer rather than shown as a large
  one: a trans cell has no distance along a sequence, and on the diagonal it is
  zero.
- **The tooltip names the genome, in the whole-genome view of a metacool.**
  It led with the contig, which on a metagenome is the finer half of the answer
  and rarely the one you want first. The genome now leads and the contig sits
  under it; a cell between two genomes names both. The picture underneath is
  unchanged — the separators are still the contigs.

- **A fifth example: a yeast micro-C map at one resolution.**
  `Yeast_microC_G2M_1kb.cool` — 16 chromosomes of synthetic yeast, 1 kb bins,
  179 M contacts, balanced. It is the first single-resolution cooler in the
  picker, so it is also the choice that lands somewhere with no resolution
  ladder to pick from.
- **Ten track resources published beside it**: MNase, ATAC, Pol II
  ChIP-over-input and stranded RNA-seq coverage, shotgun coverage, ATAC and Pol
  II peak calls, gene models, and the loop calls made on that map. They are not
  in the picker; the annotation cards above are what reads them. All ten are on
  the map's own assembly rather than on R64 — same 16 contig names, same
  lengths, no coordinate off the end of a chromosome — which is the property to
  check before republishing any of them. See
  [docs/deploy.md](docs/deploy.md#the-track-resources).

- **Works offline, and installs.** After one visit the app runs with no network at all — reload
  included — and browsers offer to install it as a standalone window. The app is cached; the data
  never is, and requests for it reach the network untouched. A new build is offered as a reload
  rather than swapped in underneath you.

- **A desktop application, for machines that cannot reach the website.** The same
  bundle packaged with Electron: a `.dmg` and a `.zip` for macOS (Apple Silicon and
  Intel), an NSIS installer for Windows, an AppImage and a `.deb` for Linux. It is a
  delivery channel and not a second feature set — it opens exactly the files the web
  build opens, in exactly the same way, with the same reader and the same privacy
  claim, and it never writes anything back. There is no auto-update: a new version is
  a new download. The first releases are **unsigned**, so macOS and Windows will each
  warn once before running it; [docs/desktop.md](docs/desktop.md) gives both warnings
  verbatim with the exact click that gets past them. The web app is unchanged — same
  URL, same build, nothing to install.

  It has a native menu, and one capability the web app cannot have: it asks
  remote hosts not to compress. `Accept-Encoding` is a forbidden header name in
  a page, so a `.metacool` served with `Content-Encoding: gzip` — which is what
  GitHub Pages does — is refused by the website with no way around it. The
  desktop build sets the header from outside the page, so the same file on the
  same host opens.

- **The footer states the privacy claim, which it had been promising to.** The
  dismissable notice on the picker says the footer keeps the same statement, and
  `StatusBar` asserted it in its own documentation, but nothing rendered it — so
  dismissing the notice removed the claim from the app. The statement is also
  reworded, in both targets, from "leaves your browser" to "leaves this machine":
  the first is false in a window that is not a browser, and the second is true in
  both.

### Changed

- **A selection opens a region instead of zooming.** Option-drag draws a square —
  it always resolved to one, so drawing a rectangle promised something it would
  not give — and releasing it opens what the square covers: the chromosome or
  contig the drag began in, ending at the edge of the box or of the sequence,
  whichever comes first. On the whole-metagenome view, where no smaller region
  exists, it opens the genome. Zoom is still the wheel, the keys and pinch.
- **Two fingers sideways go back and forward** over the heatmap, as they already
  did everywhere else on the page.
- **A selection in the trans corner opens the intersection**, not one of the two
  sequences: the rectangle between two chromosomes, or the genome pair. On the
  diagonal it is still one region.
- **Switching resolution in an `.mcool` keeps the view** you were in — the same
  genome, contig and range at the new bin size — instead of returning to the
  landing table. The colour clip is not carried, because it is in counts and
  counts scale with the bin.
- **A pooled picture says so.** Above 4,096 bins on an axis the raster is pooled,
  one pixel per block of bins carrying the strongest value under it; the summary
  now reads "drawn 4 × 4 bins to a pixel" and explains why the crosshair reports
  several coordinates inside one square, and why zooming does not sharpen it.

### Fixed

- `w` opens the whole-genome view again. The repaint short-circuit could not tell "nothing changed"
  from "show me the other picture of the same thing", and swallowed it.

## [0.2.0] - 2026-08-03

The first numbered release: everything below was built under `0.1.0`, which was never cut.

### Added

- **Opening files.** Drag and drop a local `.metacool`, `.mmetacool`, `.cool` or `.mcool` — read in
  place through the Emscripten filesystem, never uploaded — or a URL, read over HTTP range requests.
  The published demo datasets are offered as examples. A collection opens at one of its entries and
  offers the rest; an `.mcool` resolution ladder is a dropdown in the breadcrumb.
- **Tables.** A sortable, filterable genomes table as the landing view, with every metadata column
  the file carries and the free `bin1_offset` density proxy; the same for contigs. Filters, search
  and sort are remembered per file and per table.
- **Views.** One genome; the rectangular block between two genomes; a region, or the rectangle
  between two contigs; a cooler's whole genome; and the gated whole-metagenome overview, computed by
  one pass over every pixel or read from a sidecar edge list.
- **The heatmap.** Pan, drag-to-zoom on a modifier, wheel zoom, touch gestures, keyboard pan and
  zoom, a crosshair, a hover tooltip and a coordinate readout. `metacooler show`'s colour rule
  (`log1p`, 99th percentile) with typed clip bounds, a colormap picker including colour-vision-safe
  ramps, and balanced counts where the file carries weights.
- **Axis furniture.** Block names in the gutters, boundary ticks outside the plot, base-pair ticks on
  an axis with a single coordinate system, and dividers over the data. Each toggles independently.
- **Export.** PNG and PDF at 96–600 dpi, re-rendered rather than screen-grabbed, captioned with the
  file, genome, framed range, bin size, scale and time, and named with a timestamp.
- **The shell.** A file-info sidebar with a card for the row behind the current heatmap, a command
  palette, a keyboard-shortcut dialog, a light/dark/system theme, a status bar reporting bytes read,
  and an opt-in deep validation of the open file.
- **Deployment.** A static bundle published to GitHub Pages on every push to `main`, with the base
  path resolved at build time.

### Changed

- The whole-metagenome overview opens at contig level, marks genome blocks, and answers a click with
  the genome or the genome pair rather than a single contig.
- Axis labels appear as soon as fewer than fifty blocks are *in view*, so zooming brings out the
  names of a 20,000-contig map; contigs over 50 kb are labelled whatever the count. Clicking a label
  opens what it names.
- The view's controls are a column of the shell, scrolling on their own beside the plot.
- Reading, rendering and sorting were reworked for large files: a windowed pixel read, a pooled
  raster, memoised bin→unit maps, and sorting once per column rather than once per keystroke.

### Fixed

- A region no longer reaches into the next chromosome on a file whose bin table is not
  `binnify(chromsizes, binsize)` — five yeast chromosomes at 2 kb, where the extra bin also cost the
  view its base-pair ticks.
- A press no longer scrolls the canvas out from under the pointer, which made clicks near a genome
  boundary open the neighbour.
- Toggling labels no longer crops a fitted view.

## [0.1.0] - unreleased

The version the package carried while the viewer was being built. Never tagged and never deployed
under that name; its history is in the commit log.
