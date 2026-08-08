# Handoff — `claude/higlass-feature-parity-hpar2c`

Working document for whoever picks this up. Branched from **`001715f` (0.9.0)**;
everything below is new since that tag. All of it is committed and pushed.

**Green as of the last commit (`0d1ccbf`):** `npm run typecheck`,
`npm run test:nofixtures` (1123 passed, 25 skipped), `npm run build`.

`npm ci` first — the container starts without `node_modules`, and `tsc` fails
with "Cannot find type definition file for 'node'" until you do, which looks
like a code error and is not one.

---

## 1. What this branch set out to do

Close three gaps against HiGlass, raised in this order:

1. **Comparison capped at exactly two files.** → §16, the deck of panels.
2. **No derived or arithmetic maps** — O/E, ratios, on-the-fly normalisation, and
   the same for tracks. → §7.5, derived values.
3. **No 45° view.** → `render/rotate.ts`, *partially landed — see §5*.

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

## 3. The deck of panels (§16) — **skeleton only; see §3.1 for the real state**

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

**Everything below is what it does not do.** The honest summary is that the deck
is a *data* feature that works and an *interaction* feature that barely exists.

### 3.1 Gap analysis

Grouped by what a reader is trying to do. Each item names the code that would
change. Ordered within each group by what I would do first.

#### A. Getting a map in

| # | Gap | Where |
|---|---|---|
| A1 | **No drop area in single-map view.** The first companion can only be added through the command palette (`Ctrl+P` → "Add a map beside this one"), because the deck — and therefore its toolbar — does not exist until then. Nothing on screen says the feature exists. Wanted: an always-visible drop strip down the far right of the centre panel, taking a dropped file straight into a new map. | `Session.showContent` / a new always-mounted strip; `Session.addMap` is the existing entry |
| A2 | Adding by URL is a text input behind a `+ add a map` toggle. A dropped *file* is only accepted by a `VacantPanel` (a `~` slot from a link) — there is no drop target for a *new* map anywhere. | `PanelDeck.addRow`, `MapPanel.VacantPanel` |

#### B. Arranging maps

| # | Gap | Where |
|---|---|---|
| B1 | **No drag and drop at all.** Reordering is `◀` `▶` buttons on each companion's heading. Wanted: drag a map onto another to place it left/right/above/below. | `MapPanel` heading, `PanelDeck.move` |
| B2 | **The lead cannot be moved or closed.** `leadCell` is grid cell 0, always, and carries no per-panel controls — the session's own view is re-parented into it. So the first map is permanently first. This is the structural blocker for B1: a general reorder needs the lead to be *a panel like any other*, which today it is not. | `PanelDeck.leadCell`, `setLead` |
| B3 | **The layout is a uniform grid, not an arrangement.** `--deck-columns` with `row \| column \| grid`; there is no model for "this map below that one". Dropping onto an edge (B1) implies either a real layout tree or, more cheaply, insert-at-index plus a column count. Decide which before building B1. | `PanelDeck.applyLayout`, `deck.columnsFor` |
| B4 | **The lead's cell is much bigger than a companion's** — it keeps the view heading, the locus box, the back link and the block summary, while a companion has a one-line heading. At three panels the lead's map is visibly smaller than the maps beside it. Asymmetric and cramped. | `.deck-panel.is-lead` in `styles.css`; what `setLead` re-parents |

#### C. Tracks — the largest gap

| # | Gap | Where |
|---|---|---|
| C1 | **Companions have no tracks at all.** `MapPanel` builds its `MatrixPanel` with no `annotations` context, so a companion has no lanes, no track stacks, no 4C. Only the lead can carry a track. Everything else in this group follows from that. | `MapPanel.show` |
| C2 | **The annotation store is a session singleton.** `Session.annotations` is one store and one worker for the whole session. Per-map tracks needs a decision: *one store per panel* (simple, N workers, no sharing) or *one store with per-entry map membership* (one worker, sharing is natural, every consumer must learn to filter). **Nothing should be built here until that is chosen** — it is the single decision the rest of C depends on. | `Session.annotations`, `annotations/store.ts` |
| C3 | **No cross-map alignment by track stacks.** Two maps with different numbers of tracks would have their plots start at different heights, so the maps stop lining up — the thing the deck exists for. Needs a per-edge stack height reconciled across panels (a shared max, or explicit spacers). | `MatrixPanel.syncLaneMetrics`, `--lane-*` custom properties |
| C4 | **No "send this track to every map"** and no "remove it from every map". Depends entirely on C2: under per-panel stores this is a copy of an `AnnotationEntry` plus a re-fetch per panel; under one store it is a change to a membership set. | `AnnotationCard` row menu, `annotations/store.ts` |

#### D. Defects — wrong, not missing

| # | Defect | Where |
|---|---|---|
| D1 | **The 45° turn does not reach companions.** `MapPanel` never passes `turn` to its `MatrixPanel` (grep `turn:` in that file — no hits). Flipping a deck therefore flips the lead only, and the panels beside it stay square while claiming to be one navigation. Small fix — pass it through exactly as `derive` is, including the `setDerive`-style refresh on every `show` — deliberately left out of the documentation pass rather than mixed into it. | `MapPanel.show`, `MapPanel.apply` |
| D2 | The deck's DOM was never verified by its author and only lightly by me. `PanelDeck`/`MapPanel` layout is the least-exercised code on the branch, and B4 was found the first time anybody looked at three panels. Assume more of the same. | — |

#### E. Smaller, and deliberate-or-not is worth deciding

- **No deck-wide export.** Each panel exports itself; there is no "one figure of
  all of them", which is what somebody assembling a paper figure wants.
- **Companions never get the two-file compare** (`uri2`). Reasonable — a blended
  square inside a panel of a deck is two claims at once — but it is undocumented
  as a decision.
- **A vacancy cannot be made deliberately.** `VacantPanel` only ever arrives from
  a `~` in a link; there is no "leave a gap here".
- **No promote-to-lead.** With B2 fixed this becomes free; without it, a reader
  who wants a different map driving the deck has to rebuild the deck.

### 3.2 Suggested order

The dependency chain is real, and doing these out of order means doing them
twice:

1. **D1** — a defect, minutes, unblocks nothing but should not ship.
2. **C2** — decide the track ownership model. Write the decision down before any
   code. Everything in C waits on it.
3. **B2** — make the lead a panel like the others. Blocks B1 and E's promote.
4. **A1** — the drop strip; it is what makes the feature discoverable at all, and
   it is independent of B and C.
5. **B3 → B1** — pick the layout model, then build drag and drop onto it.
6. **C1 → C3 → C4** — tracks per map, then alignment, then broadcast.
7. **B4** and the rest of E.

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

## 5. The 45° turn — **partially landed**

`src/render/rotate.ts`, `test/unit/rotate.test.ts` (17). Commits `9d67ccc`
(geometry) and `0d1ccbf` (wiring). **`SPECS.md` has no section for this yet and
`CHANGELOG.md` has no entry — write both.**

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
- `flip` in the view state and the hash; in `DERIVED_KEYS`, so it takes the
  repaint road rather than the mount switch.
- The toggle (a `triangle` icon beside the overlay marks), greyed via
  `TurnPresentation.onAvailable` when the block has no diagonal.
- Applied at the same seam as the derivations, so a turned O/E map and a turned
  ratio cost one extra pass and no special case.
- x becomes an ordinary genomic axis; y's locus axis is `null`; separators
  suppressed; the readout maps back through the inverse.
- Deck-wide by construction — `turnPresentation` is built from the state and
  every panel is handed the same state.
- **Browser-verified** on `demo/ecoli`: the band draws with a correct Mb ruler
  along its bottom edge.

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

### What is NOT done — the actual remaining work

Roughly in the order I'd do it.

1. **Overlays are not rotated.** *(the long pole, and the only one that is
   currently wrong rather than absent)* `render/overlays.ts` draws lines,
   crosshairs, loops, hand-drawn marks and pairs at square-map coordinates. On a
   turned map they land in the wrong place. A vertical line should become a ray
   (`x - y = c`), a diagonal feature a horizontal line, and a **loop should become
   a single dot at the height of its span** — which is strictly better than the
   box it is now. Until this is done, a reader with annotations on a turned map is
   being shown marks that lie.
2. **Tracks do not fall to a bottom stack.** The vertical axis is correctly
   `null`, so side lanes have nothing to draw against — but they are not *moved*,
   and there is no restore-on-unflip. Precedent for remember-and-restore is the
   lane-flip rule already in `TODO.md`'s DONE list.
3. **No drag-the-top-edge gesture.** `MatrixPanel.turnRows` exists and is honoured
   by `turnDepth`; nothing writes it. The gesture to copy is the one that sets a
   track's ceiling by dragging across its body.
4. **No butterfly.** `rotateBlock` takes `direction: 'down'` and it is tested, but
   the compare path neither emits the second map nor stacks the two. Tracks go
   **below both** (user's choice).
5. **A y ruler labelled in separation.** There is currently no tick or label up
   the side at all.
6. **Empty corners.** A cell at the edge of the window and high up needs a partner
   off the end of the block. Honest as `NaN` today; filling them means reading
   wider than the window, which is a change to view read-planning.
7. **Docs.** A `SPECS.md` section and a `CHANGELOG.md` entry, plus the shipped
   items into `TODO.md`'s DONE list in that file's voice.

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

---

## 7. Known-open, not fixed

Reported honestly rather than quietly left:

- **The deck is a skeleton.** §3.1 is the full account; it is the largest body of
  remaining work on this branch by a wide margin.
- Panel layout at 4–6 panels in `column`/`grid` has never been looked at.
- The turn reaches only the lead of a deck — §3.1 D1.
- The turn's own remaining work is §5.

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
