# Handoff — `claude/higlass-feature-parity-hpar2c`

Working document for whoever picks this up. Branched from **`001715f` (0.9.0)**;
everything below is new since that tag. All of it is committed and pushed.

**Green as of the last commit:** `npm run typecheck`,
`npm run test:nofixtures` (1202 passed, 25 skipped), `npm run build`.

**State:** all three gaps in §1 are closed. The deck (§3) is complete, tracks
included; the turn (§5) is complete but for the butterfly, which is open on a
design decision rather than on work and is written up in `SPECS.md` §17.7. §7 is
the honest list of what is thin rather than missing.

`npm ci` first — the container starts without `node_modules`, and `tsc` fails
with "Cannot find type definition file for 'node'" until you do, which looks
like a code error and is not one.

---

## 1. What this branch set out to do

Close three gaps against HiGlass, raised in this order:

1. **Comparison capped at exactly two files.** → §16, the deck of panels.
2. **No derived or arithmetic maps** — O/E, ratios, on-the-fly normalisation, and
   the same for tracks. → §7.5, derived values.
3. **No 45° view.** → `render/rotate.ts` and `SPECS.md` §17 — see §5.

(1) was built by a subagent in an isolated worktree and merged; (2) and (3) were
built in the main session. The merge and the seam between them were then
adversarially reviewed, and the review's findings fixed — see §6, which is the
part most worth reading before touching anything.

---

## 2. Derived values (§7.5) — **complete**

Spec section `SPECS.md` §7.5. Changelog entry under `## [Unreleased]`.

| Piece | Where | Tests |
|---|---|---|
| VC, VC √, ICE; expected-by-distance; O/E | `src/render/derive.ts` | `test/unit/derive.test.ts` (35) |
| Two-file `split` / `ratio` / `difference` | `src/render/compare.ts` (`combine`) | `test/unit/compare.test.ts` (18) |
| Track ratio / log₂ ratio / difference | `src/annotations/derived.ts` | `test/unit/derived-track.test.ts` (17) |
| The picker the normalisations live in | `src/ui/scores.ts` | `test/unit/scores.test.ts` (6) |

**Decisions that are load-bearing.** Each is argued at length in the module head;
this is the index.

- **Juicer's `KR` is deliberately absent.** It and iterative correction solve the
  same problem and converge to the same weights; at §2's scale the fixed point
  converges in milliseconds. Offered as `ICE`, which is what it is. Do not "add
  KR" without reading `Normalisation`'s doc first.
- **Normalise before the baseline**, never the other way round. The decay curve
  is an average over cells, so measuring it before the coverage bias is out means
  measuring it partly on the bias. cooltools' order, for the same reason.
- **The expected curve is indexed from the block's own smallest separation**, not
  from zero — otherwise a 100 × 100 block covering two windows three million bins
  apart allocates 24 MB twice. Fixed in `ebe5c3f`.
- **ICE has a cell-visit budget** (`BALANCE_CELL_BUDGET`), because 200 rounds over
  a 4096² block is 3.3 billion visits on the main thread. It reports
  `converged: false` and the caption says so.
- **Depth matching is forced on for `ratio` and `difference`** and its checkbox
  hidden: there the depth scalar is a nuisance parameter with no reading.

**Diverging values needed three things to change together** — `log2` in
`Transform`, `autoSymmetricRange`, and `RdBu_r`. Changing fewer produces a
plausible picture of the wrong thing. Also: pooling of a diverging field is by
departure from neutral, *not* by maximum (`render/heatmap.ts`) — see §6.

**Browser-verified** against `demo/ecoli`: O/E draws a decay-free diverging map
captioned `O/E (log2)`; a file compared against itself under `ratio` is the
diverging ramp's centre colour across 96% of drawn pixels.

---

## 3. The deck of panels (§16) — **complete**

Spec section `SPECS.md` §16. Built by a subagent, merged in `d37f7c5`.

| Piece | Where | Tests |
|---|---|---|
| Deck reconciliation, `maps` encoding, budget split | `src/panels/deck.ts` | `test/unit/panel-deck.test.ts` (25) |
| The navigation lock | `src/panels/lock.ts` | `test/unit/panel-lock.test.ts` (25) |
| One companion: worker, panel, frame | `src/panels/MapPanel.ts` | — |
| The grid, toolbar, layout | `src/panels/PanelDeck.ts` | — |

**What genuinely works, verified in a browser at three panels and two bin sizes:**

- N files open at once, each with its own worker, block and colour scale.
- One navigation across all of them. The lock's currency is base pairs, which is
  what lets a 2 kb and a 5 kb file follow each other — and why side-by-side needs
  none of `compareRefusal`'s gate.
- `maps=a|b|~` round-trips through the hash; `~` holds a local file's slot.
- Shared: region, level, score, balance, the derivation. Per-panel: the clip,
  because `vmax` is a count and two depths do not share one.
- Memory: `panelBudgetBytes` divides one block's allowance across N, so a deck
  cannot exceed the single map it replaced. `MAX_PANELS = 6`.

**§3.1 below is the gap analysis this branch worked through, kept because each
row names the code and the reasoning.** Every item in it is now closed. Group C —
tracks on any map of a deck — was the last, and the alignment rule it forced
(C3) is written up in `SPECS.md` §16.8.

### 3.1 Gap analysis

Grouped by what a reader is trying to do. Each item names the code that would
change. Ordered within each group by what I would do first.

#### A. Getting a map in

| # | Gap | Where |
|---|---|---|
| ~~A1~~ | **Done, and not as written** — see §3.3. The `+` edges are the entry point; the drop strip is not what was built. | `panels/DeckFrame.ts` |
| ~~A2~~ | **Done.** A dropped file is taken by an empty cell, by either `+` edge, and by a `~` slot from a link. Adding by URL is still the text input behind `+ add a map`, which now fills the first empty cell rather than appending. | `PanelDeck.add`, `MapPanel.VacantPanel` |

#### B. Arranging maps

| # | Gap | Where |
|---|---|---|
| ~~B1~~ | **Done** — see §3.4. A grip before each companion's name, the tiling shown while one is held, and a drop that *exchanges* two cells. A swap and not an insert: sliding a map into a distant cell by shifting everything between here and there rearranges three pictures to move one. | `MapPanel.grip`, `PanelDeck.watchArranging` |
| ~~B2~~ | **Closed as a decision, not as work.** The first map is always the lead, by the reader's own instruction: it is the session's view re-parented into cell 0, it owns the breadcrumb and the tables and the tracks, and which file a session is *of* is not a thing that should change by dragging. It has a name like every other cell and no grip. What survives of B2 is E's promote, which is not wanted either. | `PanelDeck.leadCell`, `setLead` |
| ~~B3~~ | **Decided and built.** The deck is a **rectangle of cells filled in reading order**, with an explicit column count the reader draws with a `+` or picks in the bar, and empty cells as first-class members of the list. No layout *tree*, and there should not be one until something needs a cell two columns wide. | `PanelDeck.columnsNow`, `deck.grownDeck` |
| ~~B4~~ | **Done.** The maps line up to the pixel — the lead's lane room is reserved on every panel and every picture is pushed to the foot of its cell — and the view's own heading is *hoisted above the grid*, so cell 0 is a cell like the others. Moved rather than rebuilt, and given back when the deck is put down. | `PanelDeck.hoistHead`, `.deck-lead-head` |

#### C. Tracks

All four are done.

| # | Gap | Where |
|---|---|---|
| ~~C1~~ | **Done.** A companion is handed an annotation context of its own — the session's one store, plus the id of the map whose lanes it draws — so a panel of a deck carries tracks. `ui/AnnotationLanes.ts` needed no change: it is still given a list of entries keyed by id and never learns lanes exist. A file dropped on a companion's edge is placed on *that* map. | `MapPanel.show`, `Session.annotationContext` |
| ~~C2~~ | **Decided, built and tested** (`src/annotations/placement.ts`, `test/unit/placement.test.ts`, 20). A **track** is the import and the style true of it everywhere; a **lane** is one placement — a map, four edge booleans, and a *sparse* patch. `resolveStyle` is one spread, and the property that matters is what a lane omits: a lane with no patch cannot drift from its track. `LANE_OVERRIDES` is two fields (`limits`, `flip`) on purpose — every field a lane can differ on is a field two maps can no longer be compared on, which is why **height is shared**. | `annotations/placement.ts`, `AnnotationStore` |
| ~~C3~~ | **Done.** The reserved room is now the deepest stack on each edge **across the deck**, and every panel — the lead included — pads out the difference between that and its own (`MatrixPanel.setLaneFloor`, `--lane-pad-*`). The earlier attempt failed because it accumulated a maximum as panels reported, and they report in whatever order they finish reading: a companion's first report arrives long before the lead's, so the running maximum was a maximum over one panel. `deepestStacks` folds over all of them at the moment of use instead, which has no order to get wrong. Pinned in `test/unit/panel-deck.test.ts`; verified on screen with a track above one map and below the other, both squares at the same top and the same size. | `PanelDeck.align`, `deck.deepestStacks`, `MatrixPanel.writeLaneMetrics` |
| ~~C4~~ | **Done and seen.** The location control is one row of four edges *per map*, with `every map` (propagate, no patch) and `no map` (withdraw, keeps the import). The disclosure that would not open opened all along — the run that said otherwise had clicked a row with no track in it. What *was* broken was the control's shape: a label column and four edge buttons cannot share a sidebar row, so `bottom` read as `bottc` and both map names truncated to the shared `Ecoli.mcool…` prefix, at exactly the point where they stop being the same file. The field turns on its side. | `AnnotationCard.placement`, `edgeRow`, `everyMapRow` |

#### D. Defects — wrong, not missing

| # | Defect | Where |
|---|---|---|
| ~~D1~~ | **Done**, and it was not small — see §3.3, which lists the three further defects it uncovered. | `MapPanel`, `MatrixPanel.setTurn` |
| D2 | The deck's DOM was never verified by its author and only lightly by me. `PanelDeck`/`MapPanel` layout is the least-exercised code on the branch, and B4 was found the first time anybody looked at three panels. **Still true, and D1's three follow-ons are the evidence** — every one of them was invisible until somebody drove a browser. Assume more of the same. | — |

#### E. Smaller, and deliberate-or-not is worth deciding

- ~~**No deck-wide export.**~~ Done by §3.4: the bar saves the whole deck as one
  figure, laid out as it is on screen (`PanelDeck.saveDeck`).
- **Companions never get the two-file compare** (`uri2`). Reasonable — a blended
  square inside a panel of a deck is two claims at once — but it is undocumented
  as a decision.
- ~~**A vacancy cannot be made deliberately.**~~ Done by §3.3: a `+` makes as
  many as the shape needs, and they are the feature's entry point rather than a
  corner of it.
- **No promote-to-lead.** With B2 fixed this becomes free; without it, a reader
  who wants a different map driving the deck has to rebuild the deck.

### 3.2 Suggested order

The dependency chain is real, and doing these out of order means doing them
twice. **All of it is done**; the order is kept because it is the reason the last
two landed cleanly.

1. ~~**D1**~~ — done, and see §3.3 for what it turned out to be attached to.
2. ~~**C2**~~ — the track ownership model, decided and written down before any
   code. Everything in C waited on it, and it is why C3 and C4 were small.
3. ~~**B2**~~ — closed as a decision: the first map is always the lead.
4. ~~**A1**~~ — done as the `+` edges (§3.3).
5. ~~**B3 → B1**~~ — done: a rectangle with a drawn column count, and a grip
   that swaps two cells.
6. ~~**C1 → C3 → C4**~~ — tracks per map, then alignment, then broadcast.
7. ~~**B4**~~ and the rest of E — of which two remain, both deliberate: a
   companion never gets the two-file compare, and there is no promote-to-lead.

### 3.4 The second batch

Reported as bugs, and three of them were architecture rather than bugs.

| What | Where |
|---|---|
| `maps`/`uri2` carried across a navigation | `Session.navigate`, `COMPANION_KEYS` |
| A collection descends to the lead's rung | `MapPanel.openOrDescend`, `PanelDeck.resolveRef` |
| The score shared as a **resolved id** | `PanelDeckProps.score`, `MapPanel.scoreOf` |
| The key inside the map, in the reader's units | `src/render/legend.ts`, `src/ui/MapKey.ts` |
| The scale menu in the map's corner | `MatrixPanelOptions.cornerControls` |
| Grip, drop-to-swap, the tiling | `MapPanel.grip`, `PanelDeck.watchArranging`, `swapItems` |
| Lane room reserved, and the plot size handed over | `MatrixPanel.setLaneListener`, `PanelDeck.alignTo` |
| One figure of the whole deck | `PanelDeck.saveDeck` |

Three things worth knowing before touching any of it:

- **A navigation is a fresh state.** That is right for the region and the level
  and wrong for `maps` and `uri2`, which name what is on screen *beside* the
  view. Carrying them is `Session.navigate`'s and not the store's: the address
  bar is obeyed as written, or a pasted link shows a deck nobody sent. Every
  `store.set` inside `Session` goes through it; `App`'s hash listener does not.
- **`ColorbarView` is gone.** The key is `render/legend.ts` (content and a canvas
  draw for exports) plus `ui/MapKey.ts` (the DOM one, whose two numbers are
  editable). Its values are **transform-space** — the same numbers as the clip
  boxes — which is the opposite of the old bar's rule and is the whole point.
- **Alignment is a measured number, not a shared rule.** Two panels given the
  same custom properties still came out different sizes: their cells hold
  different content, so one plot's `clamp` bottomed out at its 20 rem floor
  while the other was capped by its column. The lead now *reports* its plot
  width and every companion is given it as `--deck-plot`. Reserving the lane
  room needs both halves — the custom properties for the height budget the
  square is computed from, and a padding for the space it actually stands in.
- **`cornerControls`, not `detachedControls`.** Every view sets the latter, to
  move its cards into the Aesthetics column; only a companion sets the former.
  Inferring one from the other put a second scale menu on the session's own map.

One thing this batch found that is worth carrying forward: **a companion needs to
be told what it is drawing, not only what to read.** `MatrixPanel` decides its
automatic range partly from `options.balance` — under `log10` a balanced cell is
negative, and negatives are kept only for a matrix that says it is balanced — so
a companion given the right *score* and not the flag drew a blank rectangle over
good data. Anything else moved from the session's own presentation into a
companion's should be checked for the same shape of gap.

Still open from this batch: a companion re-reads its block after a trip through a
table, because a view no companion can answer tears its `MatrixPanel` down.

### 3.3 What landed after the first handoff

**The entry point is `+` edges, not a drop strip** (§16.9 in the spec). The
brief changed on the way in and the new one is better: rather than a strip that
takes files one at a time, a `+` down the right of the map and another along the
bottom open a **cell**, and what comes back is the deck the reader drew with
their own map in the first cell and every other one standing empty as a drop
target. The argument is in `panels/DeckFrame.ts`'s head and is worth reading
before changing any of it — in one line, adding maps one at a time makes the
arrangement a consequence of the order the files arrived in, and the arrangement
is what somebody assembling a figure is composing.

| Piece | Where |
|---|---|
| The `+` edges, one component, two owners | `src/panels/DeckFrame.ts` |
| `grownDeck`, the shape arithmetic | `src/panels/deck.ts`, `test/unit/panel-deck.test.ts` |
| The drawn column count, `grow`, filling the first empty cell | `src/panels/PanelDeck.ts` |
| Drawn-vs-link wording on an empty cell | `MapPanel.VacantPanel` |
| The edges round a view with no deck | `Session.framed`, `Session.growDeck` |

Three things worth knowing:

- **One component, two owners.** The session wraps its view in the edges while
  there is no deck; the deck wraps its own grid once there is. Two
  implementations would drift, and the gesture has to be visibly the same act in
  both places.
- **The grid is a rectangle** and a press adds a whole edge, because a single
  extra cell on the right of a two-row grid pushes every map after it one place
  along. That is the constraint that decided B3. `grownDeck` gives the shape and
  `grownPlacement` gives *where each map goes*, and the two are only correct
  together — see §6's trap about what happens when you have the first without
  the second.
- **An empty cell is a real cell** — a slot in `maps`, a place in `MAX_PANELS`,
  movable and closable — but it is *not* in the memory budget's divisor. It has
  no worker and no block, and dividing by it read the two maps of a 2 × 2 deck at
  a quarter of the allowance each.

**D1, and the three defects behind it.** Passing `turn` through to companions
was five lines. What it exposed was not:

1. **The turn control was a latch.** The button closed over the presentation
   object captured when the panel was built, and the session replaces that
   object on every render — so after one press `turn.on` was permanently the
   value the panel opened at. It asked for a flip that was already on, could
   never ask for it to come off, and never lit up. Now read back through
   `this.options.turn`, with `setTurn` syncing the `is-on` class.
2. **The lock measured the wrong grid.** `cellCount()` and `bpPerCell()`
   answered about the square block while the viewport being reported was the
   *band*. A rotated cell is half a bin and a band is `2n − 1` columns, so a
   whole-band window came back as twice the base pairs it covers and was clamped
   to half the columns at the far end: **every turned panel of a deck drew half
   of what the panel beside it drew.** Both now answer about the drawn grid.
3. **A drop on a deck cell was taken twice.** `App.ts`'s content-area handler
   exempts `.dropzone, .lane-drop` and nothing else, so a cooler dropped on a
   vacancy opened the companion *and* was imported over the lead. `.deck-drop`
   joins the exemption; the `+` edges carry it too.

**And one that was not the turn's.** `maps` was not in
`differsOnlyInPresentation`'s allowed keys, so **every add and every close
rebuilt the lead** — a worker round trip and the reader's pan and zoom thrown
away, for a change that happened in another panel. It is now `DECK_KEYS` in
`state/ViewState.ts`. This mattered little when a deck was built once through
the palette and matters a great deal when drawing a 2 × 2 is four changes to that
key in a row.

**Reviewed adversarially** — four lenses over the diff, each finding verified by
an agent told to refute it. Twelve claims, eight survived, three distinct
defects, all fixed above: the column-splice, the SVG hit target, and the frame's
retained view. A fourth confirmed finding was the turned lock's *wording* rather
than its behaviour — a deck of two resolutions turns to two depths, which is a
real reason not to share a row window, and the refusal now says that instead of
claiming the sequences disagree. Worth repeating the shape of the miss: the
placement bug was invisible to `typecheck`, to 1,136 tests, and to a browser
check, because every check exercised a deck of one row.

**Browser-verified** on `demo/ecoli` at 1700 × 1050, driven with
`playwright-core`: `+` beside a single map gives `1 of 2` and `maps=~`; `+` below
gives `1 of 4` and a 2 × 2; a URL typed in the bar fills the first empty cell; the
turn puts *both* maps on their diagonals showing the same window, and unturns;
a file dropped on either an edge or an empty card opens there and leaves the
lead's heading and lanes untouched; a map stacked under the lead stays under it
when a column is added; closing every cell puts the deck down and brings back
the single map with its scale and its edges intact.

## 4. Where the two features meet

This is the seam that broke, and the fix is worth understanding before extending
either side.

A companion reads the same block the lead does — but **every derivation is a
transform applied *after* the read**, so a companion built without one drew raw
counts beside a lead drawing a ratio. Silently, in the one widget whose entire
purpose is that adjacent pictures are comparable.

- The derivation joins the score and the level as something the deck **shares**
  (`PanelDeckProps.derive`, a thunk so it is never stale).
- `MapPanel.keyFor` deliberately does **not** carry it — it costs no read — which
  is exactly why `MapPanel.apply` must `rederive` in place. An unchanged key
  would otherwise short-circuit and leave the companion behind.
- `DerivePresentation.onExpectedChange` is **optional**, and that is the whole of
  "apply it but do not own it": no handler, no control, values still derived.
- A companion is seeded from `MatrixPanel.baseScale()`, not the live scale — a
  lead showing a two-file `ratio` is on `log2` + `RdBu_r`, which a companion
  drawing plain counts must not inherit.

---

## 5. The 45° turn — **complete but for the butterfly**

`src/render/rotate.ts`, `test/unit/rotate.test.ts` (28),
`test/unit/overlays-turned.test.ts` (17). Written up in `SPECS.md` §17 and in the
changelog.

### Agreed spec (from the user, verbatim intent)

- y is **distance from the diagonal**, in bp, **strictly proportional to x**
  (1 bp across = 1 bp up).
- **Pixel height stays** on zoom; maxY is "what fits". Dragging the top edge makes
  the box taller, which shows more distance.
- **Deck-wide**: one toggle flips every map on screen.
- **Greyed** on anything not strictly intra-chromosomal.
- Two compared files become **two stacked rectangles** sharing one x axis, the
  second's y growing downward.
- On flip, **all tracks fall to a single stack below** the rectangle.
- Pannable, but never into negative y; may detach from y = 0.

### What is done

- The geometry, tested: `rotateBlock`, `cellAt` (inverse), `separationAt`,
  `turnedAxis`, `isTurnable`.
- **Deck-wide for real**, not only by construction — see §3.3's D1 and the three
  defects it was hiding. The lock now measures a turned panel in half-bins.
- `flip` in the view state and the hash; in `DERIVED_KEYS`, so it takes the
  repaint road rather than the mount switch.
- The toggle (a `triangle` icon beside the overlay marks), greyed via
  `TurnPresentation.onAvailable` when the block has no diagonal.
- Applied at the same seam as the derivations, so a turned O/E map and a turned
  ratio cost one extra pass and no special case.
- x becomes an ordinary genomic axis; y's locus axis is `null`; separators
  suppressed; the readout maps back through the inverse.
- **Browser-verified** on `demo/ecoli`: the band draws with a correct Mb ruler
  along its bottom edge, and a deck of two draws two bands over the same window.

### Three things that turned out to be free

Worth knowing before you "fix" them:

1. **1 bp x = 1 bp y needs no enforcement.** `HeatmapView` has a *single* `zoom`
   for both axes, and the turned lattice is half a bin on both. It is isometric
   by construction.
2. **Tracks line up already.** §8.4 gives the heatmap and the lanes one
   coordinate model, so once x is a genomic axis everything drawn against it
   follows. `AnnotationLanes` never learned the map was turned.
3. **A true rotation makes height = separation / 2.** The y axis is therefore
   *labelled* in separation while the coordinate under it is half that. Do not
   "correct" this by stretching — that puts a domain's edges at 63° and makes the
   plot unmeasurable with one ruler.

### What landed after that

Each of these was on the "not done" list above and is now in, tested, and seen on
screen. They are listed with what they turned out to cost, because the estimates
in the first handoff were wrong in both directions.

1. **Overlays turned** — and the diagnosis in the first handoff was wrong. They
   were not "drawn at square-map coordinates"; every one of them *bailed out* at
   `rows === null`, which a turned map always is, so a turned map had no marks on
   it at all. Absent rather than lying, which is better and is still a hole: the
   reader's own marks vanished when they pressed the toggle. What replaces the row
   axis is the pair of loci a mark was always about — see `SPECS.md` §17.4 for the
   four shapes. `drawDiagonalFeatures` was tested but not reachable from the UI
   when this was written — `loader.cardFor` gives the overlay card to a bedpe and
   to nothing else, so a *dropped* BED is always a lane. The Analysis branch
   reaches it: a task that calls intervals puts a `FeatureSet` on the overlay card
   itself, so a boundary set draws on the diagonal, turned or square.
2. **Tracks fall to one stack below**, and it cost less than expected because it
   is a *presentation* and not a move: `AnnotationLanes.drawnOn` asks the store for
   everything the map draws when the axes carry a turn, and the store never
   changes. Which makes the restore free. `drawnAnywhereOn` exists because a track
   on two edges must arrive once, in the list's own order — a reader orders the
   list to order the stack.
3. **The depth gesture**: a bar along the band's top edge, `MatrixPanel.watchDepth`.
   The one thing worth knowing is that the rate must be captured **at the press** —
   the band is redrawn deeper on every step, so a rate read live falls as the
   picture grows and the second half of a drag is slower than the first. Note that
   the band is recentred in the plot on each redraw, so the edge under the hand
   drifts even though the band's *height* follows it exactly. Pinning the diagonal
   instead would be a change to the fit, not to this gesture.
4. **The y ruler**, `separationCoords`. It is the same `AxisCoords` line every
   ruler is, with a negative gradient; `bpTicks` learned to order its two ends.
   The tick *gap* had to become per-axis (`AxisCoords.tickGapPx`): the default is
   the width of a bp label, and a band a hundred pixels tall fits one tick at it —
   on the diagonal, in the corner the column labels have already taken, so the
   ruler came out blank until that was found.
5. **Docs**: `SPECS.md` §17, and §16.8 rewritten — it used to say a companion
   carries no tracks.

### What is NOT done

1. **The butterfly.** Two compared files as two rectangles meeting at one genomic
   axis, the second growing downward, tracks below both. This is open on a
   **decision**, not on work. `rotateBlock` takes `direction: 'down'` and is
   tested; stacking two halves into one block is an afternoon. The problem is the
   ruler: the two halves' diagonals are *adjacent rows, not the same row*, so the
   combined y axis is two affine lines meeting in the middle, and `AxisCoords` —
   which every ruler in the app is — is one line. Three ways out, all with a cost,
   set out in `SPECS.md` §17.7: share the diagonal row (loses one file's
   self-contacts at the join), give the row ruler a supplier seam (a second tick
   mechanism beside §17.5's), or label the lower half in negative distance (one
   line serves both, and the reader has to read `-100 kb` as "100 kb, other
   file"). Pick one before writing anything. Also needs: `cellAt`/`separationAt`
   to know which half a row is in so the readout names the right file, and the
   depth grip to take the top half's edge.
2. **Empty corners.** A cell at the edge of the window and high up needs a partner
   off the end of the block. Honest as `NaN` today; filling them means reading
   wider than the window, which is a change to view read-planning.

---

## 6. Traps found the hard way

Every one of these was a real bug on this branch. They are the reason to read
before editing.

- **A diverging field must not be pooled by maximum.** An empty cell of a ratio is
  `0`, whose `log2` is `-Infinity`, and a contact map is mostly empty — so every
  pooled block contained one and infinity won all of them. Measured: 0 of 32,768
  pooled pixels finite, i.e. the whole map one colour at fit zoom, which is where
  a large map opens. Invisible below 4096 cells per axis, because nothing pools.
- **A neutral value that is not on the scale.** `log2` is offered on every map and
  a difference map's neutral is `0` → `-Infinity` → every distance infinite → the
  range `[-Inf, -Inf]`. Both the pooling and the auto range fall back.
- **The panel cannot change its own scale silently.** `mountWholeFile` calls
  `applyScale(scaleOf(state))` on *every* render, so a transform the panel chose
  without recording it is overwritten by the next render — usually the very patch
  that turned the derivation on. It must announce.
- **A derivation must never remount.** The whole-genome view is gated (§7.3);
  remounting puts a 26-million-pixel scan back behind its button, so ticking a box
  makes the map disappear. `HeatmapView.setValues` is the no-refit path;
  `differsOnlyInPresentation` is the render-path gate.
- **Shadowed loop variables.** `const base = r * ncols` shadowed the separation
  offset in `expectedModel` and silently produced garbage. Tests caught it.
- **`git add -A` at the repo root will commit an agent worktree** as an embedded
  gitlink. `.gitignore` now covers `.claude/worktrees/`.
- **A control built in the constructor cannot read the presentation.** The panel
  keeps `this.options` and the session *replaces* the object on it on every
  render, so a closure over the one that was there at construction answers with
  the state the panel opened in — for ever. The turn's button was a one-way
  switch for exactly this reason, and the O/E checkbox escapes it only because it
  reads its own DOM. Read back through `this.options` in the handler.
- **A new drop target has to be added to `App.ts`'s exemption list.** The content
  area imports any file dropped in it, and a target that only calls
  `preventDefault` still bubbles — so one drop is acted on twice. `stopPropagation`
  is not the fix: the same handler is what takes the drag highlight off.
- **A key that is neither data nor presentation defaults to a full rebuild**, and
  the default is right — but `maps` sat there for a whole feature, silently
  re-reading the lead's block every time a companion was added.
- **A CSS grid's placement is derived, so changing the column count moves
  everything.** `.deck-grid` is one flat list in `repeat(n, …)`, so cell `k` is
  at row `⌊k/n⌋`, column `k mod n` — raising `n` re-maps every index at once.
  Appending is right for a new *row* and wrong for a new *column*, which has to
  be spliced into the end of each row (`grownPlacement`). The first version of
  `grow` appended in both directions and turned a 2 × 2 into a three-wide row
  with the fourth map stranded underneath. The arithmetic was right and the
  placement was never asked about, which is why the tests passed.
- **An inline `<svg>` is not an `HTMLElement`.** `event.target instanceof
  HTMLElement` is false over any icon, so a guard written that way silently
  skips its own exemption list for the most obvious pixel on a button. Use
  `Element`; `closest` is on `Element`.
- **A frame that outlives what it frames has to be told to let go.** The
  session's `DeckFrame` is a permanent field, and `hold()` keeps the last view
  parented inside it — so navigating to a view the deck cannot frame pinned a
  destroyed heatmap's canvas for as long as the reader stayed away.

---

## 7. Known-open, not fixed

Reported honestly rather than quietly left:

- ~~**`drawDiagonalFeatures` is unreachable from the UI.**~~ **Reachable as of
  the Analysis branch (§18).** `loader.cardFor` still gives the overlay card to a
  bedpe and to nothing else, so a *dropped* BED is still always a lane — but a
  task that calls intervals now puts a `FeatureSet` on the overlay card directly
  (`AnalysisWorkspace.adoptIntervals`), so insulation boundaries and CID domains
  reach `paintOverlays` and this code runs. The link is pinned in
  `synthetic-entry.test.ts`; the drawing keeps its own tests here.
- **The depth grip's edge drifts under the hand.** The band's *height* follows a
  drag exactly, but the plot recentres on each redraw, so the top edge moves half
  as far as the pointer. Pinning the diagonal instead is a change to the fit, and
  the fit recentres everywhere else in the app.
- Panel layout at 4–6 panels has been looked at once, at 2 × 2 with two maps and
  two empty cells. Five and six cells, and any of it in a narrow window, have
  not.
- **An empty cell's card is `aspect-ratio: 1 / 1`**, which is a guess that looked
  right at two columns. It has not been seen at one column or at three.
- A companion whose block cannot be turned stays square while the deck is
  turned. It should be unreachable — every panel is asked for the same block by
  name — and if it happens the lock refuses the panel rather than mixing a
  separation axis with a position one, which is the safe failure. Not tested,
  because I could not construct it.
- The turn's own remaining work is the butterfly, §5. Everything else on that
  list is in.

---

## 8. Working conventions

- **Branch:** develop and push only to `claude/higlass-feature-parity-hpar2c`.
- **House style matters here more than in most repos.** Every module opens with
  prose explaining *why it exists and what tension it resolves*, never what it
  does. Comments name the load-bearing decision and the failure avoided. British
  spelling (`colour`, `normalise`, `centre`). Spec references as `§7.1`. No emoji.
  Read `src/render/compare.ts` and `src/panels/lock.ts` for the register.
- **Verify with:** `npm run typecheck`, `npm run test:nofixtures`, `npm run build`.
  `npm test` additionally needs Python fixtures (`npm run fixtures`) that this
  container does not have.
- **Browser checks are worth the trouble** and caught things tests did not.
  `npm run dev` serves `demo/` at `http://localhost:5173/demo/…`; drive it with
  `playwright-core` against `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
  `demo/ecoli/Ecoli.mcool` is single-chromosome, so it is the file that exercises
  the turn. Note the whole-genome view is **gated** behind a "compute whole
  genome" button — click it, or you will conclude nothing renders.
