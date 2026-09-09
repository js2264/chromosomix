# Analysis tasks — the build plan

The plan for the **Analysis** panel and the **Analysis drawer**: a fourth column beside the map that
lists what can be computed from what is open, and a workspace that opens beside it to configure a
computation, watch it run, read its result and write that result out as a file.

`SPECS.md` §18 is the specification this plan builds; where the two disagree, the spec is right and this
file is stale. `SPECS.md` §12 and §13 carry the matching budget and non-feature amendments.

**Notation.** A `§` always points at `SPECS.md`. A bare number in parentheses — *(5.8)*, *(part 6.1)* —
points at a part of this document.

---

## 0. The shape of the thing, in one paragraph

Everything the app draws today is a **reading of a file**. An analysis is a **computation over one**,
and the difference that matters is time: a reading is a frame, a computation is a job. So a job gets a
place to be configured, a thread that is not the one serving the map, a progress bar, a cancel, a record
of the exact inputs it ran on, and an output that can leave the page as a file. Everything below follows
from that sentence, and from the one constraint that has not moved: **no server** (§1, C1). cooltools,
coolpuppy and deeptools are dependencies of the *test suite*, run on a developer's machine by
`npm run fixtures`. They are not, cannot be, and will never be dependencies of the running app.

---

## 1. Three surfaces

### 1.1 The Analysis panel — the list

A fourth `SidePanel`, and *only* a spec, because `SidePanelSpec` (`src/ui/SidePanel.ts:35-116`) is
already data rather than code:

```ts
export const ANALYSIS_PANEL: SidePanelSpec = {
  key: 'metacooler-viewer:analysis-collapsed',
  title: 'Analysis',
  side: 'right',
  order: 2,             // outside Aesthetics, which is 1
  defaultWidth: 300,
  minWidth: 240,
  maxWidth: 520,
  closeIcon: 'flask-conical',
  openIcon: 'flask-conical',
  keys: 'j',
}
```

`j` because `b`, `a` and `m` are the other three columns and the single-letter space is otherwise almost
exhausted between `ui/commands.ts:31-88` and `ui/plotOptions.ts:189-201`.

It holds one row per task: title, a one-line blurb, and a state chip — *never run*, *running* with a
progress ring, *done* with the time it took, *failed* with the reason. **A task that means nothing on
this file is absent, not disabled**, which is the §8.5 doctrine applied to a second thing: a `.metacool`
has no gene models, so it has no metaplot row, and a `.cool` has no genomes, so it has no MAG rows. What
a row is *for* is opening the drawer on that task.

The running state lives in the row, not only in the drawer, so a job you started and then folded away is
still visibly running.

`styles.css:3265-3283` drops `.panel-general` under 60rem; the narrow layout gets a matching rule and
keeps Analysis, because it is the one column of the four that is a place to *do* something.

### 1.2 The Analysis drawer — the workspace

**Not a `Modal`.** `src/ui/Modal.ts` is right for a question and wrong for a workspace: `App.onKeyDown`
returns early whenever `this.modal !== null` (`src/app/App.ts:743`), so a drawer built on it would kill
every shortcut in the app, and `Modal.ts:57-59` dismisses on any backdrop mousedown, which after a
forty-second scan is hostile.

So a new `ui/AnalysisDrawer.ts`, which is a panel that happens to float:

- anchored to the right of `.app-body`, full height, over the content column *and* over the two right
  panels;
- **resizable by its left edge**, width remembered in `localStorage` beside the panel widths,
  double-click to reset — the same mechanics `SidePanel.handle()` already has, which is why that method
  is factored into `ui/resizeHandle.ts` and called by both rather than written twice;
- default width 75% of `.app-body`, min 380 px, max 95%;
- opened by clicking a task row, closed by its own × or by pressing `j` twice;
- **does not take the keyboard**: Escape returns focus to the map and leaves the drawer up, an outside
  click does nothing, and every shortcut keeps working behind it.

Header: the task's title, the framing it is about to use (or did use), and the close button. Body: the
parameter form, a **Run** button with a pre-flight cost line beside it, then progress, then results and
their export buttons.

Open-or-closed is **per session**, not per window. A folded column is a preference about this window; an
open task is a fact about this file. Switching tabs therefore shows the drawer exactly when that tab had
one open, and the content re-parents through a `Session.analysisDrawerHost` in the same way
`generalHost`/`annotationsHost`/`aestheticsHost` already do (`src/app/Session.ts:413-415`).

### 1.3 The Synthetic tracks card — where per-bin results go

Anything a task produces that is **one value per bin** is a track, and a track belongs on the map, not in
a drawer. This is not a new idea in this codebase; it was the whole of the virtual 4C lane's design
(§8.9). That lane has since been removed — the task below answers the same question from the file —
but the argument it made is the one this card is built on. A second results surface for an object that
already has one is exactly the drift §5.8 exists to prevent.

So a fourth `AnnotationCard`, `'synthetic'`, on the **Annotations** panel, under Tracks. Its rows are
ordinary `AnnotationEntry`s with `kind: 'track'` — which means colour, rename, limits, autoscale, ceiling
drag, edge, reorder, group, tooltip, hairline, the 1D browser and the exported figure all work because
they are the same implementation, not a copy of it.

Two things distinguish a synthetic row:

- `source: { kind: 'computed', name, task, params, framing }` — a fifth `AnnotationSource` case, so the
  row can say what made it and a session can carry the recipe;
- an **export row** on the card: **bigWig**, **bedGraph**, **TSV**. This is where a bigWig actually leaves
  the app (part 6.1).

**How a synthetic lane gets drawn** is the part worth getting right. The lane renderer asks the
annotations worker for samples over a window (`annotations/worker/protocol.ts`, `kind: 'sample'`). So a
finished synthetic vector is **registered with the annotations worker as a bin-vector source**, and from
that moment nothing downstream can tell it from a bigWig: same request, same `TrackSampleSet`, same
`profileOf`, same everything. One new request kind (`register`), and zero renderer changes.

**Persistence.** A vector is megabytes; session storage is not for that. The *recipe* is persisted
instead, and on reload the row comes back `status: 'detached'` with a **Recompute** button — precisely
the state a dropped local file returns in, for precisely the same reason
(`annotations/types.ts:425-429`, §8.6). `SessionConfig` carries the recipe too, so a shared session hands
a colleague the same analysis one click away rather than a number they have to trust.

---

## 2. The task model

### 2.1 One descriptor, one form renderer

Adding a task must be adding a **descriptor**, never adding a UI. The precedent is `ui/plotOptions.ts`,
where one table drives the labels, the marks, the tooltips and the command list, and the copy that goes
stale is the one that does not exist.

```ts
// src/analysis/types.ts
export interface AnalysisTask {
  /** Stable. Used in storage, in the config and in provenance; never a title. */
  id: string
  title: string
  /** One line for the panel row. */
  blurb: string
  group: 'map' | 'tracks' | 'metagenome'
  /** Bumped when the numbers this task produces change meaning. */
  version: number
  /** Whether this file, in this state, has anything for this task to do. */
  appliesTo(context: AnalysisContext): boolean
  /** Rendered by one generic form builder. */
  params: readonly ParamSpec[]
  /** What comes out, so the panel row and the drawer know what to offer. */
  outputs: readonly OutputSpec[]
  /** Tasks whose results are inputs to this one; see 2.4. */
  requires?: readonly string[]
  /** Range requests and bytes, before anything is read. Shown beside Run. */
  estimate(context: AnalysisContext, params: Params): CostEstimate
  /** The job itself. Runs in the analysis worker, never on the main thread. */
  run(job: JobContext): Promise<TaskResult>
}
```

`AnalysisContext` is what the drawer knows before anything runs: the open file's layout and assembly, the
loaded annotations, the current framing (part 4), and whether a dense block is already in memory.

### 2.2 Parameters — everything is one

**Every task is parametrised.** A task with a hard-coded window is a task somebody will need to fork.
`ParamSpec` is a small union, and the form builder is the only place that turns one into a control:

| Kind | Control | Notes |
|---|---|---|
| `number` | box, optional slider | carries `min`, `max`, `step`, and a `unit` of `'bp'` or `'bins'`; a bp value is resolved against the file's bin size and the resolved value is shown under the box |
| `choice` | segmented buttons or a select | ≤ 4 options are buttons |
| `toggle` | the app's existing mark-style button | |
| `featureSet` | dropdown over loaded `gtf`/`segments` entries | **defaults to the starred one** (`AnnotationEntry.primary`, `annotations/types.ts:465`) |
| `pairSet` | dropdown over loaded `pairs` entries | |
| `track` | dropdown over bigWig **and synthetic** entries | multi-select where a task takes several |
| `sequence` | dropdown over loaded FASTA entries | |
| `column` | dropdown over the numeric columns of a chosen feature set | `score`, plus anything numeric parsed into `detail` |
| `region` | the locus box the views already use | defaults to the current framing |
| `seed` | integer box with a dice button | present on every task that samples; see part 4 |

Parameter values are remembered per `(file, task)` in `UiMemory` (`state/UiMemory.ts:48-63`), so
re-opening a task offers what you last ran, and they go into `SessionConfig` so a shared session carries
them.

### 2.3 Outputs

Five kinds, and a task may produce several:

- **`profile`** — one value per bin → a synthetic track (1.3). Exports: bigWig, bedGraph, TSV.
- **`matrix`** — a small 2D array (a pileup, a saddle, a correlation heatmap) → drawn in the drawer
  through the existing `render/heatmap.ts` rasteriser and colormaps. Exports: TSV, PNG, PDF.
- **`curve`** — x/y with an optional band (P(s), a metaplot) → drawn in the drawer. Exports: TSV, PNG, PDF.
- **`table`** — rows and columns → the existing `ui/VirtualTable.ts`, sortable and filterable for free.
  Exports: TSV; and BED/BEDPE where the rows are intervals.
- **`intervals`** — a `FeatureSet` or `PairSet` → offered as a **new row on the Annotations panel**, so
  called boundaries become an overlay on the map immediately. Exports: BED/BEDPE.

Every plot in the drawer is drawn through a `CanvasRenderingContext2D`, which means `ui/vector.ts`'s
`VectorPage` gives each of them a true vector PDF with no extra work (`src/ui/vector.ts:130-172`).

### 2.4 Composite tasks

Some results are inputs to others, and pretending otherwise produces three tasks that each recompute the
same expected curve. A task declares `requires`, and the runner resolves the chain, reusing a cached
result when its parameters and framing match and recomputing when they do not. The drawer shows the chain
as it runs (*expected → correlation → eigenvectors*), which is also the honest answer to "why is this
taking so long".

Three composites exist at the start: **saddle** requires eigenvectors and expected; **APA with O/E
normalisation** requires expected; **CID** requires insulation and then APA over its own boundary calls
(5.9).

### 2.5 What is remembered, and what is not

| Thing | Where | Why |
|---|---|---|
| Panel fold, drawer width | `localStorage` | a window preference, like the other three columns |
| Which task is open | session memory | a fact about this file, not this window |
| Parameters, per task | `UiMemory` + `SessionConfig` | so re-running is one click and a shared session is reproducible |
| Result vectors and matrices | memory only | megabytes; the recipe is persisted instead |
| Synthetic track recipes | `UiMemory` + `SessionConfig` | comes back `detached` with **Recompute** |
| Anything at all in the URL hash | **no** | the hash is one view state (§5.5). The framing is an *input* to a task, and it is already in the hash; the task is not a view |

---

## 3. Threading — the piece that decides whether this is pleasant

The requirement is flat: **a long task must not stop you from panning.** Today the reader worker owns the
HDF5 mount, so a scan inside it makes the next `matrix` request wait, and the map freezes. The annotations
worker's own header already makes this argument for its own split
(`src/annotations/worker/protocol.ts:1-16`); this is the same argument a third time.

### 3.1 A third worker

`src/analysis/worker/analysis.worker.ts`, with **its own h5wasm mount of the same source**.

- **Local files cost nothing.** A `File` is structured-cloneable by reference; the second worker reads the
  same bytes through its own handle with no copy and no re-download.
- **Remote files cost a second `RemoteRangeSource` and its LRU.** In practice the overlap is small,
  because an analysis mostly reads pixels the view never asked for. Measured, not assumed: `test/budgets/`
  gets a case for it.
- **Opened lazily**, on the first task that needs a mount, and closed with the session. A session that
  never opens the panel pays nothing.
- Registers with `perf/threads.ts:43-50`, so it appears in the CPU meter and the status bar for free.

### 3.2 The rules

1. **No analysis ever runs on the main thread.** Not even a cheap one. A rule with an exception is a rule
   somebody will drop a frame through.
2. **The reader worker is never asked to do analysis work.** This is what makes the map stay live for the
   whole duration, and it is stated as a budget in part 8 so it is testable rather than aspirational.
3. **One job at a time per session**, queued FIFO. Two concurrent scans on one file thrash the same byte
   source and finish later than they would in sequence.
4. **Every job is cancellable and reports progress**, through the `scanHooks` idiom the overview scan
   already uses (`src/worker/reader.worker.ts:102-108`). Cooperative yields via `async.ts`'s
   `yieldToEventLoop`.
5. **A job survives navigation and tab switches.** Pan, zoom, click a chromosome, switch tabs, come back —
   it is still running, and the panel row says so. It is bound to the *session*, not to the mounted view.
6. **A job does not survive the session.** Closing the tab cancels it and terminates the worker.

### 3.3 Where the input comes from

Two ways, chosen by the task and stated in its estimate:

- **A copy of a block the view already holds.** Cheap when the block is small — a yeast chromosome at 1 kb
  is 1,531² cells, 9 MB, and structured-cloning that costs a few milliseconds. Used by anything whose
  input is exactly what is on screen.
- **Its own reads.** Bounded reads for a diagonal band or a pileup window; a streaming pass with progress
  and cancel for the whole-file cases. Used by everything else, and by anything the view has not loaded.

The one thing never done is transferring the view's block *away* from the main thread: `Transferable`
would neuter the array the heatmap is drawing from.

---

## 4. Framing, provenance and determinism

### 4.1 The framing is an input, and it is a snapshot

**The map's current framing is what a task runs on**, and it is captured at the moment **Run** is pressed:
the row and column bin extents, the file's bin size, `binsPerCell` if the block was pooled, the score
column, and whether balancing is on. Panning afterwards does not change a finished result — it is a
record, not a live view — and the drawer says which framing it is a record of, with a **Recompute here**
button that snapshots the new one.

This is the honesty the on-the-fly 4C profile never managed — it redrew itself from whatever block was
loaded — and it is why the whole-genome 4C task (5.4) is a different object from that lane rather than a
bigger version of it. Different enough, in the end, that the lane is gone (§8.9).

### 4.2 Provenance travels with the numbers

Every result carries: task id and version, every parameter, the framing snapshot, the file URI, the app's
version and commit (`src/version.ts`), and a timestamp. It is shown in the drawer header, copied by a
**Copy provenance** button, and written into every export the format allows as `#` comment lines — TSV,
bedGraph and BED all skip them, and `annotations/export.ts:38-50` already does exactly this for hand-drawn
marks.

**bigWig carries none**, because BBI has nowhere to put it. Writing it into the `autoSql` string offset
would technically work and is rejected: that field means something else, and a file that lies about its
own structure to carry a comment is worse than a file with no comment. It is a reason to offer the TSV
beside the bigWig, not a reason to abuse the header.

### 4.3 Determinism

A figure has to come out the same twice. Every task that samples — distance-matched APA controls,
bootstrap confidence intervals — takes a **seed** parameter with a stable default, and uses a small seeded
PRNG in `analysis/random.ts` rather than `Math.random()`. The seed is part of the provenance. Two runs
with the same seed and the same parameters produce bit-identical output, and the test suite asserts it.

---

## 5. The catalogue

Cost is stated per task as: **free** (from a block already in memory), **bounded** (a few range requests),
or **scan** (a streaming pass, gated with progress and cancel like §7.3's overview).

### 5.1 P(s) — contact probability versus distance

First-class, and first to build: it is the most-used Hi-C QC plot there is, and it is the `expected` that
three other tasks need.

- **Params:** scope (`contig` / `genome` / `whole file`), log-binning factor (default 1.1 bins per decade
  step), minimum separation, balanced on/off, score column, and whether to also plot the log-log
  **derivative** (slope), which is where the biology usually is.
- **Input:** a loaded block where there is one; otherwise a streaming pass over the diagonal bands.
- **Output:** a `curve` per contig or per genome, overlaid with a legend; and the **expected** vector per
  scope, cached for 5.5, 5.6 and 5.8.
- **Cost:** free / scan.
- **Metacool note:** per MAG, and this is a genuine metagenomics diagnostic — a MAG whose P(s) has no
  decay is a MAG whose contacts are noise.

### 5.2 Coverage and marginals — synthetic tracks

- **Params:** which of *total*, *cis*, *trans*, *cis/trans ratio*; balanced on/off; score column.
- **Output:** one `profile` each → synthetic tracks, exportable as bigWig.
- **Cost:** free from a loaded block; one bounded band pass otherwise.
- **Why it matters:** a coverage track beside the map is how you see that a "domain" is a coverage
  artefact, and the cis/trans ratio is the standard balancing diagnostic.

### 5.3 Diamond insulation and boundary calls

- **Params:** **window size** (bp or bins, default 10 bins, freely settable — this is the parameter
  everybody changes), optionally **several windows at once** producing one track each, minimum valid
  fraction inside the diamond before a bin is called `NaN`, balanced on/off, score column; and for the
  boundary pass: prominence threshold, minimum spacing, and whether to report strength.
- **Output:** a `profile` per window → synthetic tracks; and `intervals` → boundary calls as a BED, which
  land on the Annotations panel as an overlay on the map.
- **Cost:** free from a loaded block; a bounded diagonal-band read otherwise. Linear in bins × window.
- **Correctness notes:** never sum across a contig boundary — the run structure is already in
  `AxisGroup.unitStart`/`unitBin` (`worker/protocol.ts:224-287`) — and never across a MAG boundary on a
  metacool. `NaN` inside the diamond is skipped, not propagated, following `bandSums`
  (`analysis/viewpoint.ts`).

### 5.4 4C profile — cis by default, trans on request

Distinct from the on-the-fly viewpoint lane — and distinct enough that the lane has since been removed
in its favour (§8.9), leaving the gesture that fed it as a 1D zoom.

- **Params:** anchor (a locus box, with a **Pick on map** button that arms the next drag), **`cis only`
  (default on)**, balanced on/off, score column, and the output bin size.
- **Cost, and this is the whole design of the task:**
  - **cis only** — the anchor's own contig or genome. Bounded: the row band, one slice of `bin1_offset`
    and one of the pixel columns. Free when that block is already loaded.
  - **with trans** — not a bounded read, and the plan says so rather than discovering it. `planRead`
    (`metacooler/matrix.ts:523-529`) resolves rows = anchor band, cols = everything to `symmetric` with a
    span of the whole pixel table, because the upper-triangular store keeps the columns *before* the
    anchor in other rows. Done properly it is one streaming pass over the pixels with
    `bin1 < anchor_end` — on average half the file — accumulating into a band of `|anchor|` rows and never
    materialising anything large. Progress bar, cancel, and a pre-flight estimate in bytes.
- **Output:** a `profile` → a synthetic track → **a bigWig**, which is the point of the task.
- The two are one task with a toggle, not two tasks, because they answer the same question and the toggle
  is the honest way to show what the second one costs.

### 5.5 Compartments — O/E, correlation, eigenvectors

- **Params:** scope (**per contig**, which is the default and usually the only affordable one), expected
  source (this file's own P(s), or a supplied expected), number of components (1–3), correlation type
  (Pearson), and the phasing controls below.
- **Phasing.** A **Phase by** dropdown listing every loaded gene model and segment set — **defaulting to
  the starred one** — every loaded FASTA for GC content, and *don't phase*. The sign of each component is
  flipped so that positive correlates with the chosen signal, and **the correlation coefficient used is
  reported**; below a settable |r| the drawer says the phasing was ambiguous rather than silently picking
  a sign. This step is usually the reason people need a second tool, and here both signals are already in
  the session.
- **Output:** `matrix` (the correlation heatmap, drawn with the existing diverging colormaps), `profile`
  per component → synthetic tracks → bigWig.
- **Cost gate.** The correlation matrix is N². A bin-count gate mirroring `checkDenseSize`
  (`metacooler/matrix.ts:96-108`), with a message in the same voice, naming the bin count, the bytes and
  what to do about it. For orientation: yeast chrIV at 1 kb is 1,531 bins → 9 MB; a whole yeast genome at
  1 kb is 12,100 bins → 586 MB; human chr1 at 100 kb is 2,490 bins → 25 MB, and at 10 kb is 2.5 GB and
  refused.
- **Eigen solver:** power iteration with deflation for 2–3 components, ~60 lines in `analysis/linalg.ts`.
  No dependency; there is nothing here that warrants one.
- **Honesty note in the UI:** compartments are weak in yeast and are not the right concept for bacterial
  MAGs at all, where the structure is CIDs (5.9). The task is absent on a metacool.

### 5.6 Saddle plot

Requires 5.5 and 5.1. ~30 lines once both exist, and it is the standard companion figure.

- **Params:** number of quantile bins (default 50), whether to trim extreme quantiles, expected source.
- **Output:** `matrix` + the AA/BB/AB strength numbers under it.
- **Cost:** free, given its inputs.

### 5.7 Metaplot — 1D tracks over feature sets

- **Params:**
  - **tracks** — any number of bigWig *or synthetic* entries;
  - **feature set**, defaulting to the starred one;
  - **mode**: **reference-point** (start / end / centre / TSS, ± a settable flank, default 2 kb) or
    **scaled-region** (upstream flank → `Fu` bins, body → `B` bins, downstream flank → `Fd` bins);
  - bin size in bp, strand-aware on/off (uses `FeatureSet.strand`, `annotations/types.ts:149`);
  - **ranking and subsetting** — sort by a chosen numeric column and take top-N, bottom-N, a quantile
    band, or split into K equal groups drawn as K curves (5.9 is what this exists for);
  - **average** (mean / median / trimmed mean), **band** (bootstrap CI at a settable level, seeded, or SD,
    or none), missing-data policy.
- **Output:** a `curve` per track (or per group), and a companion `matrix` — the N × W feature heatmap,
  sortable — because the mean of a bimodal set is a line that describes nothing.
- **Where it runs:** the **annotations worker**, which already owns the bigWig handles and the parsed
  feature sets, and already takes many regions in one `sample` request. The aggregation happens there and
  only the profile crosses back; sending N × W floats to the main thread to average them would be the
  whole point missed.
- **Cost:** no matrix I/O at all.

### 5.8 APA — aggregate peak analysis, 2D

**Reads one small block per feature, at the file's native bin size, and never a bounding box.** This is a
deliberate decision and the reason is resolution: a whole-genome import is pooled by
`rasterStride`/`binsPerCell` at `RASTER_MAX_DIM = 4096` (`render/heatmap.ts:51-61`), so on any sizeable
genome a pileup taken from it would silently inherit a coarsened bin. k small reads inherit nothing.

- **Params:**
  - **anchors** — a `pairSet` for off-diagonal (loops), or a `featureSet` for on-diagonal;
  - **mode**: **fixed** (centre ± W bins, default 25 — the classic APA square) or **scaled-region** (the
    on-diagonal domain, or the off-diagonal rectangle between two anchors, resampled to a fixed `B × B`
    grid with flanks at a settable fraction of the feature length);
  - **normalisation**: **distance-matched controls (default)**, **observed/expected**, or **none**;
  - for distance-matched: **controls per feature** (default 5), how they are drawn (shift both anchors by
    a random offset preserving the separation, or pair random anchors at matched separation), minimum and
    maximum separation, and the **seed**;
  - **ranking and subsetting** — the same control as 5.7: rank by a numeric column, take top-N or split
    into K groups and produce K pileups side by side;
  - balanced on/off, score column, minimum valid fraction before a window is dropped.
- **Normalisation, spelled out** because the user-facing choice matters: O/E divides each cell by the
  expected at its diagonal offset and therefore *requires* the expected curve — the runner computes or
  reuses 5.1 and says so in the chain. Distance-matched divides the real pileup by a pileup of controls
  drawn at the same separations, which controls for the distance decay *and* for local coverage, and is
  the default for that reason.
- **Output:** `matrix` (the pileup, plus the control pileup and the ratio when distance-matched), the
  **P2LL** enrichment score and a centre-vs-corner ratio under it, and a `table` of per-feature scores →
  TSV, so a ranked loop list can leave the app.
- **Cost, and how it survives §12:**
  - a window is `(2W+1)²` cells — at W=25 that is 2,601 cells, ~10 kB;
  - **local files: no network at all.** A `File` read is a `slice()`, and k reads is the right answer with
    nothing to trade;
  - **remote files: coalesce, then estimate, then let the user decide.** `MetaCooler.pixelBandsOf`
    (`metacooler/MetaCooler.ts:957-975`) already merges bin ranges into pixel bands with a
    `PIXEL_BAND_GAP` tolerance — exactly the coalescing this needs, and loop anchors cluster, so it helps
    a great deal in practice. The drawer shows a pre-flight line before **Run** — *5,000 windows → 3,180
    requests after coalescing, ≈48 MB* — which is the §7.3 gating pattern: expensive things are offered
    with their price, not hidden and not refused.
  - progress and cancel throughout; partial results are discarded, not shown.

### 5.9 CID — chromosome interaction domains

Not a new algorithm, and that is the point. A composite of things that already exist:

1. **insulation** (5.3) at a settable window, with bacterial-appropriate defaults;
2. **boundary calls** from its minima, with a settable prominence;
3. **APA over those calls** (5.8, on-diagonal, scaled-region), which is the validation — a real boundary
   set produces a visible corner in its own pileup, and a spurious one does not;
4. the **ranking and subsetting** control, so the top-N strongest boundaries by insulation strength (or by
   any numeric column of a supplied set) can be aggregated separately from the rest. This is what turns
   "here are 400 calls" into "the top 50 look like this and the bottom 50 look like nothing".

- **Output:** `intervals` (the domains as a BED, the boundaries as a BED), a `profile` (the insulation
  track), and the pileups.
- Offered on **both** coolers and metacools, and on a metacool it runs per MAG. This is the domain concept
  that actually applies to bacterial chromosomes.

### 5.10 Track correlation matrix

- **Params:** which tracks (bigWig and synthetic), the units to correlate over (fixed bins at a settable
  size, or the intervals of a chosen feature set), Pearson or Spearman, log transform on/off.
- **Output:** `matrix` (correlation heatmap with the values written in) and a `table` → TSV.
- **Cost:** annotations worker only; no matrix I/O.

### 5.11 Interval set overlap

- **Params:** two or more feature sets, minimum overlap fraction, strand-aware on/off.
- **Output:** a `table` of pairwise counts, Jaccard indices and fraction-overlapping; and `intervals` for
  the intersection and the two differences, which land on the Annotations panel.
- **Cost:** free. The sets are already sorted with a per-contig index (`annotations/types.ts:139-185`), so
  this is a merge join.
- Small, and worth having because "how many of my loops sit at a boundary" is the question that follows
  every 5.9 run.

### 5.12 MAG contact QC — metacool only

- **Params:** balanced on/off, score column, whether to include `__unbinned__` in the *denominator* (never
  as a row — §7.4).
- **Output:** a `table`, one row per genome: contigs, bins, bins with any contact, intra-MAG contacts,
  inter-MAG contacts, intra fraction, contacts per bin, and the free density proxy from §4. Sortable and
  filterable through `ui/VirtualTable.ts`; exports as TSV.
- **Cost:** one streaming pass, or free where the overview has already been computed.

### 5.13 MAG purity and contamination — metacool only

- **Params:** minimum contacts before a contig is judged, the plurality margin at which it is flagged,
  balanced on/off.
- **Output:** a `table`, one row per contig: its MAG, its top external partner MAG, the fraction of its
  contacts going there, and a flag; `intervals` → a BED of flagged contigs; and a `profile` of per-contig
  purity → a synthetic track, exportable as bigWig over the metacool's own assembly.
- **Cost:** one streaming pass with progress and cancel.
- **Why this task exists:** it is the analysis nobody else offers, it is what a metagenomic Hi-C reader
  actually wants, and it is the answer to the Analysis panel otherwise being nearly empty on the app's
  primary format.

### 5.14 Split-MAG detection — metacool only

- **Params:** minimum contigs and minimum bins before a MAG is judged, the cross-block ratio at which it
  is flagged.
- **Method:** the contig-level matrix per MAG — which the reader already produces via `aggregate` at
  `level: 'contig'` — then a spectral (Fiedler-vector) two-way split, then the ratio of cross-block to
  within-block contacts. A low ratio means the MAG is two things.
- **Output:** a `table` per MAG with the ratio and the two contig lists, and `intervals` → a BED per side.
- **Cost:** free per MAG once the contig-level block is read; bounded per MAG otherwise.

### 5.15 Inter-MAG contact network — metacool only

- **Params:** level (genome), balanced on/off, minimum edge weight, normalisation (raw, by bin count, by
  the product of the two MAGs' coverage).
- **Output:** a ranked edge `table` → TSV in the same column order `metacooler network --level genome`
  writes, so the two are interchangeable downstream; and the `matrix` itself.
- **Cost:** the genome × genome overview (§7.3) — instant when a `metacooler network` sidecar is
  advertised, a full scan otherwise, gated exactly as it is today.

### 5.16 Explicitly not built

Stated so they are decisions rather than omissions, and mirrored into `SPECS.md` §13 and §18.9:

- **No loop or dot calling.** HiCCUPS-class calling needs FDR control over several local backgrounds, and
  a half-good caller inside a viewer is a liability that gets cited. *Scoring* an existing loop set is
  5.8, and that is the honest version of this.
- **No contig reordering or scaffolding from contacts.** It would only be useful if the app could write
  the reordered file back, and it will not (below).
- **No writing of `.cool`, `.mcool` or `.metacool`.** h5wasm could technically create one in its virtual
  filesystem, so this is a decision and not a limitation: derived contact matrices are a format contract
  this app does not want to own, and §13's "no write access of any kind" is extended to cover files the
  app *derives*, not only the file it opened.
- **No differential APA.**
- **No differential insulation task.** Two insulation tracks from two files are two synthetic tracks, and
  comparing tracks is something the app already does.

---

## 6. Writers

### 6.1 bigWig — `src/analysis/write/bigwig.ts`

Built, because a bigWig is what a user actually wants at the end of the day, and "now convert it with
`bedGraphToBigWig`" is a command-line dependency in an app whose whole claim is that it has none.

**What makes this affordable** is that the input is never arbitrary: it is one value per bin, over a known
assembly, at a fixed bin size. That deletes most of a general writer.

**Layout**, little-endian throughout (which is what UCSC writes on x86 and every reader detects from the
magic):

| Part | Contents |
|---|---|
| Header, 64 B | magic `0x888FFC26`, version 4, `zoomLevels`, `chromosomeTreeOffset`, `fullDataOffset`, `fullIndexOffset`, `fieldCount`/`definedFieldCount` = 0, `autoSqlOffset` = 0, `totalSummaryOffset`, `uncompressBufSize`, reserved |
| Zoom headers, 24 B each | `reductionLevel`, reserved, `dataOffset`, `indexOffset` |
| Total summary, 40 B | `validCount` u64, `min`/`max`/`sumData`/`sumSquares` f64 |
| Chromosome B+ tree | magic `0x78CA8C91`, `blockSize`, `keySize`, `valSize` = 8, `itemCount`; then nodes, leaves holding `key[keySize]`, `chromId` u32, `chromSize` u32 |
| Full data | a u64 count, then the sections |
| Section, 24 B header + items | `chromId`, `chromStart`, `chromEnd`, `itemStep`, `itemSpan`, `type`, reserved, `itemCount`; zlib-compressed as a unit |
| R-tree index | magic `0x2468ACE0`, `blockSize`, `itemCount`, bounding chrom/base pairs, `endFileOffset`, `itemsPerSlot`; leaves 32 B, internal nodes 24 B |
| Zoom levels | each its own section list and R-tree; zoom records are 32 B |
| EOF | the header magic again |

**Six decisions, each with its reason:**

1. **bedGraph-type sections (`type = 1`), not fixedStep.** Twelve bytes per item instead of four, which
   for a whole yeast genome is 145 kB instead of 48 kB before compression — irrelevant. What it buys is
   two correctness problems deleted: a bin with no data is *omitted* rather than written as a `NaN` that
   every downstream tool would report as a value, and the last bin of a contig — which is partial, because
   `unitLength` is not a multiple of the bin size — is written with its true end rather than overrunning
   the sequence. One code path, no clamping bug.
2. **zlib via `CompressionStream('deflate')`**, which is already in the codebase for the PDF exporter
   (`ui/export.ts:147-156`) and produces exactly the RFC 1950 framing BBI sections use. `uncompressBufSize`
   is the largest uncompressed section. Where `CompressionStream` is absent the file is written
   uncompressed with `uncompressBufSize = 0`, which is a legal bigWig — the same fallback the PDF writer
   already takes.
3. **One bottom-up tree builder for both trees.** The chromosome B+ tree and the R-tree have the same
   shape — fixed fan-out, leaves in sorted order, one header per node — and a metacool with 20,000 contigs
   needs the B+ tree to be genuinely multi-level rather than the single leaf a small assembly gets away
   with.
4. **Offsets by the same accumulator the PDF writer uses.** Chunks are pushed into a list with a running
   length, exactly as `ui/export.ts:191-199` does, and the header is written last against known offsets. A
   genome's worth of bins is kilobytes, so holding it all is free.
5. **Standard zoom ladder**: first reduction at 10 × the bin size, then ×4 per level, up to 10 levels,
   stopping when a level reduces to fewer items than the block size. Each level is computed from the base
   vector by aggregation, not by re-reading anything.
6. **Two header fields are verified rather than asserted.** The u64 at `fullDataOffset` and the exact
   `itemsPerSlot` semantics are the two places writers most commonly disagree, so the plan does not claim
   certainty about them — the round-trip test below is what settles them, and if it disagrees with this
   table the table is what changes.

**The test that makes this trustworthy is closed-loop and costs nothing new:** `@gmod/bbi` is *already a
dependency* (`package.json`), so a test writes a bigWig from a known vector, reads it back with the app's
own reader, and asserts equality of every value, the header summary, and each zoom level. On top of that,
a golden from `pyBigWig` cross-checks the bytes against a writer nobody in this repo wrote.

Roughly 700–900 lines with this repo's comment density.

### 6.2 The text writers

- **bedGraph** — trivial, and the same gap handling as the bigWig so the two files agree cell for cell.
- **BED / BEDPE** — extend `annotations/export.ts`, which already round-trips through the app's own parser
  and has the test to prove it (`test/unit/manual-export.test.ts`). Boundary calls, flagged contigs,
  domains and ranked loop tables all go out this way.
- **TSV** — offered on **every** output, and this is the highest-value writer in the list: it is what makes
  a figure in a paper checkable. Provenance as `#` comments at the top.
- **PNG / PDF** — free for every plot in the drawer, through `canvasToPng`, `canvasToPdf` and `VectorPage`
  (`ui/export.ts`, `ui/vector.ts`). Drawer plots draw through a 2D context and therefore export as true
  vector, not as a photograph of a chart.

### 6.3 What is not written

`.cool`, `.mcool`, `.metacool` — see 5.16. `.hic` — same reason, plus a format this app does not read.

---

## 7. Correctness

This is the largest hidden cost in the whole plan, and it is the part that decides whether anyone should
believe the numbers. `README.md:237-256` sets the bar: goldens exported from the reference implementation,
and *exact integer equality* for anything derived from counts.

Analysis outputs are floats, so the bar changes shape but not height:

- **`scripts/make_analysis_golden.py`**, run by `npm run fixtures:analysis`, writes them into
  `test/golden/analysis/`. A second script rather than a section of `make_golden.py`, which is a
  deviation from what §18.10 says and a deliberate one: the two prove different layers, against
  different references, to different bars, on different inputs — the reader against metacooler and
  cooler on the synthetic fixtures, the analysis against cooltools on the published demo data. Folding
  them together would mean a run that half-succeeds on a machine missing one package and a manifest
  that has to say which half. Every golden it cannot build is **named** in its manifest, because an
  absent golden and an unwritten one look identical from the JS side. New dev dependencies, Python
  only: **cooltools** (expected, insulation, eigs, saddle), **coolpuppy** (APA), **deeptools**
  (`computeMatrix`, for the 1D metaplots), **pyBigWig** (the bigWig cross-check).
- **The mirroring factor is written into the golden, not left to be rediscovered.** cooltools counts
  each pixel *pair* once per diagonal; the viewer accumulates over a **dense** block, and a dense block
  mirrored out of an upper-triangular store holds every off-diagonal pair twice — so its `sum` and its
  `count` are both doubled and its **mean is unchanged**. The golden compares `count.avg` and carries
  `count_doubles_off_diagonal: true`. Comparing the sums instead fails by exactly two on every
  off-diagonal offset, which is the kind of failure that gets "fixed" by halving something in the
  wrong place.
- **A stated tolerance per task**, recorded in the golden file rather than in the test, so it is data:
  `1e-6` relative for anything that is a sum or a ratio of sums; `1e-4` for eigenvectors, where the solver
  differs; exact for counts, bin indices and interval bounds.
- **Eigenvector sign** is compared up to a flip *before* phasing and exactly *after* it, since phasing is
  the step that makes the sign meaningful.
- **The demo yeast dataset is the fixture.** `demo/yeast/` already carries `Yeast_microC_G2M_1kb.cool`,
  `Yeast_microC_loops.tsv`, `Yeast_microC_anchors.bed`, a real GTF, a FASTA and five real bigWigs. Every
  task above can be goldened against it, on real data, at no cost in new fixtures.
- **Determinism tests**: same seed, same parameters → bit-identical output, twice in a row.
- **Round-trip tests**: bigWig out → `@gmod/bbi` in; BED out → the app's own parser in.
- **A budget test per remote task**, in `test/budgets/`, in the shape the existing ones have.

An insulation score that differs from cooltools by three per cent is worse than no insulation score at
all, because somebody will put it in a figure. The goldens are not a nice-to-have here; they are the
feature.

---

## 8. Performance budgets

Added to `SPECS.md` §12, which is a table with regression tests behind it and not a wish list.

| Operation | Budget |
|---|---|
| **Any analysis, effect on the view** | **0 dropped frames, 0 blocked reader requests** — pan and zoom stay live for the whole run |
| Insulation / coverage / P(s), block already loaded | 0 range requests |
| Insulation, block not loaded | ≤ 5 range requests per contig |
| 4C, cis | ≤ 5 range requests |
| 4C, with trans | one streaming pass over pixels with `bin1 < anchor_end`; progress and cancel; pre-flight estimate shown |
| APA, k windows, local file | 0 network; ≤ k bounded reads after coalescing |
| APA, k windows, remote | ≤ 2 range requests per coalesced window; pre-flight estimate shown before **Run** |
| Metaplot, k features | 0 matrix reads; ≤ 1 `sample` request per contig touched |
| Correlation / eigenvectors | 0 range requests beyond the block; refused above the bin-count gate |
| Analysis worker mount | opened on first use, never at session open |

---

## 9. Milestones

All six are implemented. What follows is what each one turned out to be, because
several of them are not what this section said before they were built.

### A1 — the surfaces, and one task end to end · **done**
Panel (`j`), resizable drawer, task descriptors, the generic form, the analysis
worker with its lazy mount and queue, the synthetic tracks card, framing and
provenance, and P(s).

*Changed during the build:* the workspace became a **dynamic import**. §18.3
promises that a reader who never opens the panel pays nothing, and that was true
of the mount and false of the download — statically imported, the drawer, plots,
form and writers were 75 kB of the main chunk. It is now a lazy chunk and the
main bundle is within 4 kB of where it started.

### A2 — the bigWig writer, and the tracks that need it · **done**
`write/bigwig.ts` with round-trip and byte-level tests; coverage and marginals;
diamond insulation with a window ladder and boundary calls.

*Changed:* the multi-window control is a **doubling ladder from a settable base**
rather than a free-text list of widths — a list needs a text control this form
does not have and a parser with its own failure modes, to express what a base and
a count express exactly. And the four BBI header fields in part 6.1 were settled
by measurement against the demo files; two of them were not what the table said,
and §18.7 now records the measurements.

### A3 — 4C as a task · **done**
Cis and with-trans, the early-stopping scan, the pre-flight estimate.

### A4 — the aggregation tasks · **done**
Metaplot in both modes with ranking and bootstrap bands; APA in both modes with
all three normalisations and read coalescing; CID as the composite.

*Changed:* APA is **not** declared a composite, though part 2.4 said it would be.
`requires` is static and the runner resolves it before every run, so declaring
`expected` would compute a whole-file P(s) on every APA while O/E is not the
default — and the expected an APA needs is narrower than the task's anyway: the
offsets its own windows span, accumulated from squares it is already reading. CID
*is* a genuine composite, and so is the inter-MAG network.

### A5 — compartments · **done**
O/E → correlation → eigenvectors with the bin-count gate and the phasing
dropdown; saddle; track correlation; interval overlap.

*Was incomplete, finished in A7:* **GC-content phasing.** It shipped with a note
saying the option was unavailable, because the sequence lives in the annotations
worker and compartments runs in the analysis one. It is now wired the way open
question 6 said it should be — a per-bin vector across `TaskInputs`, resolved
identically to a chosen bigWig — rather than by giving one task a third venue.

### A6 — the metagenome tasks · **done**
MAG contact QC, inter-MAG network, purity and contamination, split-MAG detection.

### A7 — the correctness pass · **done**
Not in this plan when it was written; part 7 was going to be paid inside the six milestones and was
not. What it turned out to be:

- **The goldens, built and run.** Eight of them against cooltools, coolpuppy, pyBigWig and numpy on the
  demo micro-C map; `test/unit/analysis-golden.test.ts` runs the kernels against them. See open
  question 7 for what they proved and where the definitions genuinely differ.
- **Interval outputs actually reach the Annotations panel.** `AnalysisWorkspace.adopt` handled profiles
  and nothing else, while the drawer told the reader in so many words that a called interval set "is on
  the Annotations panel, drawn on the map it was called from" — a sentence over a panel with nothing new
  on it. Boundaries and domains now arrive as an overlay row through the same `begin` → `ready` door a
  dropped BED goes through, and a second run of the same task replaces its row rather than adding one.
- **BED out, and back in.** `annotations/export.ts` gained a `FeatureSet`/`PairSet` writer, so the
  module that writes the hand-drawn marks is the module that writes a called boundary set — one opinion
  about half-open ends rather than two. `analysis-bed-export.test.ts` asserts the round trip through
  this app's own sniffer and parsers, and that a second trip is a fixed point.
- **The budget tests.** `test/budgets/analysis.test.ts`, in the shape `requests.test.ts` has, against
  the *committed* demo cooler rather than the uncommitted reference metacool — so unlike the existing
  budget suite it runs wherever the repository is checked out. Five of §12's ten analysis rows; the
  first row is about two workers rather than about I/O and no request count can express it.
- **GC-content phasing, and the input channel underneath it.** Open question 6, closed the way it said
  it should be. A `sequence` parameter now resolves to a per-bin vector fetched from the annotations
  worker and shipped in `TaskInputs`, which also fills in `RunnerHost.vector` — declared in A1, never
  implemented, and the same silent gap for the `track` parameter.

## 10. Files

**New:**

A task is **two** files, not one, and the split is load-bearing rather than tidy:
`analysis/tasks/<id>.ts` holds the descriptor and is imported by the panel, the form and the
registry on the **main thread**; `analysis/run/<id>.ts` holds the runner and is imported only by the
worker. A `JobContext` names `MetaCooler`, and `worker/reader.worker.ts` opens by claiming to be the
only module in `src/worker/` and `src/ui/` that does. One file per task would drag the reader into
the main bundle and quietly end that claim. See `src/analysis/job.ts`'s header.

```
src/analysis/
  types.ts                 AnalysisTask, ParamSpec, TaskOutput, TaskResult, provenance   [done]
  job.ts                   JobContext, TaskRunner, param accessors, abortError           [done]
  context.ts               AnalysisContext from an open file; the startBin arithmetic    [done]
  memory.ts                one UiMemory scope holding every task's last parameters       [done]
  registry.ts              the catalogue; what applies to which file
  runner.ts                queue, composites, cache, cancel, progress
  random.ts                the seeded PRNG                                               [done]
  stats.ts                 log binning, quantiles, bootstrap, Pearson/Spearman           [done]
  expected.ts              P(s) and the expected curve                                   [done]
  linalg.ts                power iteration with deflation; Fiedler split
  insulation.ts  viewpoint.ts    compartments.ts  saddle.ts
  metaplot.ts    apa.ts          overlap.ts       mags.ts
  tasks/<id>.ts            the descriptors — main-thread safe, no MetaCooler
  run/<id>.ts              the runners — worker-side
  run/index.ts             RUNNERS, by task id                                           [done]
  worker/
    protocol.ts            the vocabulary, TaskInputs, BlockInput, the transfer list     [done]
    client.ts              AnalysisClient, in ReaderClient's idiom                       [done]
    analysis.worker.ts     the third thread, with its own lazy mount                     [done]
  write/
    tsv.ts                 every output as a table, with provenance                      [done]
    bigwig.ts              the writer
    tree.ts                the shared bottom-up node builder, for both BBI trees
    bedgraph.ts
src/ui/
  AnalysisPanelCard.ts     the task list
  AnalysisDrawer.ts        the workspace
  ParamForm.ts             one renderer for every ParamSpec
  analysisPlots.ts         curve, matrix and table figures, drawn through a 2D context
  SyntheticCard.ts         the Annotations-panel card and its export row
  resizeHandle.ts          factored out of SidePanel, used by both                       [done]
```

**Touched:**

```
src/ui/SidePanel.ts        ANALYSIS_PANEL, and the handle factored out               [done]
src/app/App.ts             the fourth column, its toggle, its command, the drawer slot [done]
src/app/Session.ts         analysisHost, drawerHost, panels getter, availability     [partly]
src/ui/MatrixPanel.ts      analysisFraming() and analysisBlock()                     [done]
src/annotations/types.ts   the 'synthetic' card and the 'computed' source            [done]
src/annotations/store.ts   persisting a computed row's recipe                        [done]
src/annotations/loader.ts  a computed source has no bytes and says so                [done]
src/state/SessionConfig.ts task parameters in an exported session                    [done]
src/ui/styles.css          the fourth column, the drawer, the figures, narrow layout [done]
scripts/build-icons.mjs    beaker, play, circle-stop, rotate-cw, table               [done]
src/annotations/worker/*   the 'register' request for a bin-vector source
scripts/make_golden.py     the analysis goldens
SPECS.md                   §18, plus amendments to §12 and §13                       [done]
README.md                  the feature table; and the stale balancing paragraph (below)
```

**One correction to make regardless of any of this:** `README.md:170` says balancing is unavailable.
`SPECS.md` §6.4 and `MetaCooler.ts:763,844` both say it is built and bounded. Every task above wants
balanced input, so the stale paragraph should go before it misleads someone into thinking these tasks run
on raw counts.

---

## 11. Open questions

1. ~~**Does the analysis worker's second `RemoteRangeSource` cost real duplicate bytes?**~~ **Answered:
   one chunk.** `test/budgets/analysis.test.ts` measures it as a difference — one source doing the
   view's read and then the analysis reads, which is what a shared cache would cost, against two
   independent sources doing the same two things. On the demo cooler, with the view sitting on one of
   the four chromosomes being scanned, the difference is **1,048,576 bytes — exactly one 1 MiB chunk**,
   or 9.0 % of the 11.6 MB a shared cache would have moved. It is not proportional to what the analysis
   reads and not proportional to what the view holds: it is the chunks where the two access patterns
   overlap, at chunk granularity. The `SharedWorker` fallback this entry named is not warranted.
2. **Should a finished result survive a reload?** Recipes do, vectors do not. If recomputing a 40-second
   scan on every reload proves annoying, IndexedDB is the answer — but only after somebody is annoyed.
3. **Multi-window insulation as N tracks or one track with N ranges?** N synthetic tracks with a shared
   autoscale group is the first cut, because the group machinery already exists.
4. **The two BBI header fields in 6.1** — settled empirically in A2, and this document is what gets
   corrected.
5. **Does the drawer want a "pop out to a full view" for the matrix-heavy tasks?** Deferred. The 75%
   drawer is probably enough, and a second layout is a second thing to keep in step.
6. ~~**How should GC-content phasing reach the compartments task?**~~ **Resolved — through `TaskInputs`,
   as this entry said it should.** A `sequence` parameter is now resolved the same way a `track` one is:
   the main thread asks the annotations worker to `sample` the entry at `basesPerPixel = binsize`, maps
   the intervals onto the bin grid area-weighted, and ships the vector under the parameter's own key.
   `run/compartments.ts` therefore has no idea a FASTA was involved, and phasing by GC cost the task no
   third venue.

   Two things fell out of it that were not foreseen. The vector is fetched for the **analysis venue
   only** — sending it to the annotations venue would hand that worker a copy of the file it is holding
   — which meant `inputsFor` had to learn the venue it is assembling for. And `RunnerHost.vector` had
   been declared since A1 and never implemented, so the `track` parameter had the same gap silently;
   one implementation now closes both.
7. ~~**The goldens have not been run.**~~ **Resolved — they have.** This was the single largest piece of
   unfinished work in the plan, and it is closed. `scripts/make_analysis_golden.py` now writes eight
   goldens into `test/golden/analysis/`, built from `demo/yeast/Yeast_microC_G2M_1kb.cool` with cooler
   0.10.4, cooltools 0.7.1, coolpuppy 1.1.0, pyBigWig 0.3.25 and numpy, and
   `test/unit/analysis-golden.test.ts` runs the kernels against them — twenty assertions, all passing.
   Three things about how it came out are worth recording here, because none of them was foreseen in
   part 7:

   - **Every golden carries *two* oracles, not one.** `direct` is this repo's own definition
     recomputed in numpy and is compared to equality; `reference` is the other tool's number under
     *its* definition, compared to whatever relation actually holds. Writing only the second would
     have meant either a fuzzy tolerance everywhere or a test that fails on a legitimate difference of
     definition. `direct` is what catches a bug; `reference` is what catches a wrong definition.
   - **Three of the relations are exact, and getting them exact took work.** P(s) against
     `expected_cis` is equal cell for cell once `ignore_diags=0` is passed — cooltools masks the first
     two offsets and this repo measures them. Coverage is `cooltools_cis == ours + diagonal`, exactly,
     because cooltools sums the pixel table by both ends and this repo counts a diagonal pixel once
     (`analysis/coverage.ts` says why). APA against coolpuppy is equal once the loops whose window
     would cross the main diagonal are excluded — with them in, the two differ by about 1 % and every
     differing cell is below the diagonal.
   - **Insulation is *not* comparable to cooltools by equality, and the golden says so in five
     clauses.** The diamonds differ by a row, cooltools drops the first two diagonals, divides by a
     count of valid positions rather than summing, normalises by the region median rather than the
     contig mean, and masks positions near a dropped bin. What is left is a correlation of 0.61–0.85
     on this dataset — budding yeast at 1 kb has little domain structure — so the golden records the
     *measured* correlation per chromosome and window, and the test asserts it has not degraded.
     The same is true of compartments against `eigs_cis`, where chromosome III is essentially
     uncorrelated and chromosome VI is 0.94. The eigensolver itself is proved against a full
     `numpy.linalg.eigh` of the *same* correlation matrix, which is the check that means something.

   What is still not goldened, and why: the four MAG tasks (no published tool computes per-MAG contact
   purity), the saddle (its inputs are goldened and the arithmetic on top is ten lines), CID (an APA
   with a ranking), and track correlation (scipy would be the oracle and the statistic is
   `analysis/stats.ts`'s, which has its own file).
