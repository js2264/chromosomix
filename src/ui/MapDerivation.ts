/**
 * The values a map draws when they are computed rather than read (§7.5): the
 * recipe a block is derived by, and the two jobs that run off the main thread
 * on its way to the picture — the correlation between its rows, and the
 * adaptive despeckle.
 *
 * The arithmetic is `render/derive.ts`'s and is synchronous. What is here is
 * what lets part of it wait: a job is asked for while the block it is about is
 * drawn, a real picture of the same region stands under the veil meanwhile, and
 * the answer is held under a key that says exactly which block and which
 * setting it answers — so a redraw never asks twice, a late answer to a
 * question nobody is asking any more is dropped, and a job for a block that has
 * gone is cancelled rather than left to finish.
 *
 * Its own class rather than a run of methods on `ui/MatrixPanel.ts`, because
 * that bookkeeping — two caches, two jobs in flight, two lines on one veil — is
 * a small state machine with a narrow edge: the panel hands it a block and gets
 * the values back, and it hands the panel a line for the veil and a request to
 * draw again. The panel owns the block and the veil; this owns the waiting.
 */

import type { CorrelationField } from '../analysis/compartments'
import { alignable } from '../render/compare'
import {
  deriveBlock,
  paperZeros,
  type AxisRun,
  type DerivedValues,
  type Derivation,
  type SmoothedField,
  type SmoothingRequest,
} from '../render/derive'
import { isCancellation, type Cancellable } from '../worker/client'
import type { MatrixResult } from '../worker/protocol'
import { armsFor, armsInForce, armsKey } from './armFrame'
import type { MatrixPanel, MatrixPanelOptions } from './MatrixPanel'

/**
 * The largest square the map will correlate, per axis: the block cap, so any
 * square block the map can read, it can correlate.
 *
 * The correlation is `m²/2` correlations of `m` cells each — the one **cubic**
 * step in the viewer, where everything else it draws is linear in the cells on
 * screen. It was capped at 1,500 when each pair was computed on its own, at
 * 2.8 s for 929 bins and a projected four minutes at 4,096: a limit that was
 * the difference between a wait and a coffee break.
 *
 * `analysis/pearsonRows.ts` computes all the pairs as one matrix product in
 * WebAssembly with SIMD, and `analysis/pearsonThreads.ts` shares it across the
 * cores. Measured in Chromium with four cores, from picking the score to the
 * picture: **a thousand bins in under half a second, 2,048 in under one, 4,096 in
 * two and a half** — of which the analysis thread's part is a tenth of a second,
 * a third of one and under two. On one core 4,096 is about four seconds. So the
 * cap is the block cap rather than a budget of its own, and a whole bacterial
 * genome at 1–2 kb, or a human chromosome at 50 kb, correlates about as fast as
 * it reads.
 *
 * Two things around the product mattered as much as the product. The square is
 * the O/E with an **empty pixel as the zero it is** — the matrix the compartment
 * call correlates — where the picture's own ratio blanks it (`render/derive.ts`'s
 * `keepZeros`): blanked, a sparse map at 1 kb had a few hundred missing cells a
 * row, each pair's arithmetic was an exception to correct for, and the job was
 * eight times slower than the product. And picking the score **reads nothing**:
 * the block on screen is the block correlated (`Session.render`).
 *
 * The job still runs on the analysis thread, reports a percentage and is
 * cancelled by picking another score, as it was when a wait was expected.
 *
 * `MAX_CORRELATION_BINS` in the compartments task is 8,192 for the same
 * quantity: there a reader has asked for a number and waits for it on purpose,
 * and the square is read for it rather than being a block already on screen.
 */
export const MAP_CORRELATION_BINS = 4096

/**
 * What the derivation needs of the panel it computes for: the panel's options,
 * and the two things a job that lands has to reach — the veil, and a redraw.
 */
export interface DerivationHost {
  /**
   * The panel's own options object, not a copy. The session swaps its
   * derivation and its comparison in with every render
   * ({@link MatrixPanel.setDerive}, {@link MatrixPanel.rederive}) and the bin
   * size moves with every block ({@link MatrixPanel.setResolution}), so they
   * are read here as they stand at the moment they are needed.
   */
  readonly options: MatrixPanelOptions
  /** Veil the map with a line of text, or take the veil down: {@link MatrixPanel.setBusy}. */
  setBusy(busy: boolean, message?: string): void
  /**
   * Derive the block in hand again with every setting as it was — what an
   * answer that has landed asks for, since nothing a reader set has changed.
   */
  redraw(): void
}

/** One map's derivation: the recipe, the two jobs, and what they have answered. */
export class MapDerivation {
  /** The panel's options, held by reference; see {@link DerivationHost.options}. */
  private readonly options: MatrixPanelOptions

  /**
   * Which block the values in {@link correlation} were measured on.
   *
   * Bumped on every {@link MatrixPanel.setData}, and that is what the counter
   * is *for*: the cache key is otherwise made of shapes and extents, and a
   * reader switching from balanced counts to raw ones is re-read on the
   * identical grid. Every field of the key would match and the correlation of
   * the previous quantity would be drawn under the new one's caption.
   */
  private blockGeneration = 0

  /**
   * The last correlation computed, the key it answers, and what it was a
   * correlation *of* — the derivation's label and scope when it was sent.
   */
  private correlation: {
    key: string
    field: CorrelationField
    label: string
    scope: string | null
  } | null = null

  /**
   * The one in flight, if any, the key it will answer, and the picture drawn
   * under the veil meanwhile — kept so a redraw before the answer does not
   * derive the block again.
   */
  private correlating: {
    key: string
    job: Cancellable<CorrelationField>
    operand: DerivedValues
  } | null = null

  /**
   * The veil's text while a correlation runs, or `null`.
   *
   * Held apart from {@link MatrixPanel.setBusy}'s own argument because the
   * two waits nest: `setData` clears the veil as it finishes, and the job it
   * started on the way through has seconds still to run. Without this the map
   * came back from a read looking finished and then changed under the reader
   * some seconds later.
   */
  private correlationNote: string | null = null
  /** A smoothing already computed, for the block and setting it names. */
  private smoothed: { key: string; field: SmoothedField } | null = null
  /** The smoothing on its way, so a superseded one can be cancelled. */
  private smoothing: { key: string; job: Cancellable<SmoothedField> } | null = null
  /** The smoothing's own line on the veil, kept apart from the correlation's. */
  private smoothingNote: string | null = null

  constructor(private readonly host: DerivationHost) {
    this.options = host.options
  }

  /**
   * A new block has arrived — {@link MatrixPanel.setData}, before it derives
   * one. The keys cannot infer this; see {@link blockGeneration}.
   */
  newBlock(): void {
    this.blockGeneration++
  }

  /**
   * The correlation's line on the veil, or `null`: for the veil's owner, whose
   * clear must not take down a wait that outlives the read that started it
   * ({@link MatrixPanel.setBusy}).
   */
  get correlationWait(): string | null {
    return this.correlationNote
  }

  /**
   * The values each file draws, before the two are put together: the first half
   * of {@link MatrixPanel}'s own `derive`.
   *
   * `aligned` is the second file where it can be drawn beside the first at all
   * and `theirs` is its values; both are absent for one file. A job this needs
   * is started on the way through, and what comes back meanwhile is a real
   * picture of the same region (see {@link correlated}).
   */
  derive(
    data: MatrixResult,
    second: MatrixResult | undefined,
  ): { mine: DerivedValues; theirs: DerivedValues | undefined; aligned: MatrixResult | undefined } {
    // Every derivation is applied to each file *separately* and before the two
    // are put together, because each is a statement about one library: file 2's
    // coverage bias is file 2's, and a baseline measured across a ratio is a
    // baseline of nothing. `runs` is the same for both by construction — the
    // compare gate refused any second file whose sequences differ.
    const runs: { rows: readonly AxisRun[]; cols: readonly AxisRun[] } = {
      rows: data.rowGroups,
      cols: data.colGroups,
    }
    const wantsCorrelation = this.options.derive?.correlate === true
    // Asked before the derivation rather than after, because the answer decides
    // what the derivation *is*: a refused correlation is not a correlation drawn
    // badly, it is O/E with a sentence attached.
    const refusal = wantsCorrelation ? this.correlationRefusal(data, second) : null
    const correlating = wantsCorrelation && refusal === null

    const derivation: Derivation = {
      normalise: this.options.derive?.normalise,
      // A correlation *of* observed-over-expected, always. The distance decay is
      // the largest thing in a contact map by far, so every pair of rows in a
      // raw or balanced square correlates near 1 and the picture is a uniform
      // wash — the correlation is only a compartment object once the decay has
      // been divided out (§18.8). Carried by the score rather than asked for
      // separately (`ui/scores.ts`), and the caption names both steps.
      //
      // On `wantsCorrelation` and not on `correlating`, so a *refused* one still
      // draws the O/E underneath it. That is the nearest true picture to what
      // was asked for, and dropping back to plain counts would change the map
      // twice — once for the refusal and once for a baseline nobody withdrew.
      //
      // **Never under a ratio of two maps** (§7.5): the ratio is the comparison
      // against a baseline, the second map, and the O/E toggle is greyed while
      // it is drawn. The setting stays the reader's, for a split or a difference.
      expected:
        (this.options.compare?.op ?? 'split') !== 'ratio' &&
        (wantsCorrelation || this.options.derive?.expected === true),
      // Last word, and `deriveBlock` gives it one: a reader who left the toggle
      // on and then asked to see the baseline gets the baseline, not a field of
      // ones. The toggle is greyed to say so rather than silently ignored.
      baseline: this.options.derive?.baseline === true,
      // Applied inside `deriveBlock`, which is what puts it on *each file* and
      // ahead of `combine` — the whole reason a ratio can be smoothed at all
      // (`render/smooth.ts`).
      smooth: this.options.derive?.smooth ?? '0',
    }
    // `options.binsize` is the block's own — the read's bin size times its
    // pooling, set from the block before it is derived (`setResolution`).
    const arms = armsFor(data, armsInForce(this.options.derive), this.options.binsize)
    if (arms !== undefined) derivation.arms = arms
    const aligned = second !== undefined && alignable(data, second) ? second : undefined
    // A compared pair is never deferred: two blocks would need two jobs, and a
    // half-finished pair would put a smoothed map over an unsmoothed one and call
    // the result a ratio. Both are computed inline instead.
    if (this.options.derive?.smoothBlock !== undefined && aligned === undefined) {
      derivation.deferSmoothing = true
    }
    const smoothKey = this.smoothingKey(data, derivation)
    if (this.smoothed !== null && this.smoothed.key !== smoothKey) this.smoothed = null
    if (this.smoothed?.key === smoothKey) derivation.smoothed = this.smoothed.field

    // Where a correlation is to be drawn it derives what it needs, and a held one
    // needs nothing — see `correlated`.
    const derived = correlating ? this.correlated(data, derivation, runs) : deriveBlock(data, derivation, runs)
    // Wanted and not held: start one, and draw the unsmoothed field meanwhile.
    // Exactly the correlation's arrangement — the operand is a real picture of
    // the same region, and the caption does not claim it is the smoothed one.
    if (derived.pending !== undefined) this.startSmoothing(smoothKey, derived.pending)
    else if (this.smoothing !== null && this.smoothing.key !== smoothKey) this.forgetSmoothing()
    // The correlation replaces the whole field, which is why it is applied here
    // rather than inside `deriveBlock`: every step in there is synchronous and
    // this one is not, so the panel is the only place that can hold the answer
    // between the request and the frame that draws it.
    const mine = correlating
      ? derived
      : refusal === null
        ? derived
        : // Said in the caption, which is the only place that survives an export.
          // A correlation the reader picked and did not get has to be visible on
          // the figure: the O/E under it is a real picture and looks like one, so
          // nothing else on screen would betray that it is not what was asked for.
          { ...derived, scope: `correlation not drawn — ${refusal}` }
    if (!correlating && this.correlating !== null) this.forgetCorrelation()
    const theirs =
      aligned === undefined
        ? undefined
        : // Its own derivation object: a window sized on the lead's cells says
          // nothing about this file's, and `smoothed` left in place would put the
          // lead's values into the companion's half of the ratio.
          deriveBlock(aligned, { ...derivation, smoothed: undefined }, runs)
    return { mine, theirs, aligned }
  }

  /**
   * Why this block cannot be correlated, or `null` when it can.
   *
   * Three refusals, and each is about the *object* rather than about the cost
   * except the last.
   *
   * A **pair of files** has none: the correlation of a ratio is not a quantity
   * anybody reads, and correlating each file and dividing is worse — a ratio of
   * two correlation coefficients is not a correlation of anything.
   *
   * A block whose **two axes are different stretches** has none either. "The
   * correlation between rows `i` and `j`" is a statement about two bins of one
   * sequence measured against the same set of partners, and on a `contig_A ×
   * contig_B` block the rows and the columns are not the same bins at all.
   *
   * And **size**, which is the one that is only a budget — see
   * {@link MAP_CORRELATION_BINS}. Worded rather than hidden, because a greyed
   * control that does not say what it wants is a control a reader concludes is
   * broken.
   */
  private correlationRefusal(data: MatrixResult, second: MatrixResult | undefined): string | null {
    if (this.options.derive?.correlateBlock === undefined) {
      return 'not available in this view'
    }
    if (second !== undefined && (this.options.compare?.op ?? 'split') !== 'split') {
      return 'one file at a time — the correlation of a ratio is not a correlation'
    }
    const square =
      data.nrows === data.ncols &&
      data.rowExtent[0] === data.colExtent[0] &&
      data.rowExtent[1] === data.colExtent[1]
    if (!square) return 'needs a square block — both axes over the same bins'
    if (data.nrows > MAP_CORRELATION_BINS) {
      return `${data.nrows.toLocaleString()} bins a side is past the ${MAP_CORRELATION_BINS.toLocaleString()}-bin limit — open the file at a coarser resolution`
    }
    return null
  }

  /** What identifies the square a correlation was measured on. */
  private correlationKey(data: MatrixResult, derivation: Derivation): string {
    return [
      this.blockGeneration,
      data.nrows,
      data.rowExtent[0],
      data.rowExtent[1],
      derivation.normalise ?? '',
      String(derivation.expected === true),
      derivation.smooth ?? '0',
      armsKey(this.options.derive?.arms),
    ].join('|')
  }

  /**
   * The correlation of this block if it is already computed, or the block
   * unchanged with a job started to compute it.
   *
   * Returning the operand while the answer is on its way is the deliberate part.
   * The alternative — blank until it lands — throws away a real picture of the
   * same region for several seconds to avoid showing the reader the thing their
   * correlation is *of*, and the veil already says what is happening.
   *
   * **It derives what it needs itself**, which is why the caller hands it the
   * recipe rather than a derived block. A held correlation replaces the whole
   * field, so the O/E under it is not computed at all — a pass over every cell,
   * half a second at 4,096 bins, spent on the redraw that lands the answer for a
   * picture nobody would see. A job to start takes the ratio with an empty pixel
   * as the zero it is ({@link Derivation.keepZeros}), and it is sent before the
   * picture under the veil is made — from that same ratio, the empty pixels
   * blanked, which is all that separates the two.
   *
   * A despeckle still to come is waited for rather than raced: a correlation of
   * the unsmoothed field would be drawn under a caption naming the smoothing,
   * and then computed again once the smoothing landed.
   */
  private correlated(
    data: MatrixResult,
    derivation: Derivation,
    runs: { rows: readonly AxisRun[]; cols: readonly AxisRun[] },
  ): DerivedValues {
    const key = this.correlationKey(data, derivation)
    const held = this.correlation
    if (held !== null && held.key === key) {
      const { field } = held
      return {
        values: field.values,
        // Centred on zero, not on one: this is a correlation coefficient and its
        // neutral is no correlation. `preferredTransform` reads that and leaves
        // the values linear, which is right — a coefficient on `log2` would be
        // undefined over half its own range.
        neutral: 0,
        label: `${held.label} · correlation`,
        // What a reader has to know to believe the picture, and the one thing
        // the map itself cannot show: a dropped bin is drawn blank, and blank is
        // also what a sparse corner looks like.
        scope:
          field.dropped > 0
            ? `${field.dropped.toLocaleString()} of ${(field.kept + field.dropped).toLocaleString()} bins had too little data to correlate`
            : held.scope,
      }
    }
    const running = this.correlating
    if (running !== null && running.key === key) return running.operand
    // Of the ratio with an empty pixel as the zero it is, not the paper it is
    // drawn as: the matrix the compartment call correlates.
    const input = deriveBlock(data, { ...derivation, keepZeros: true }, runs)
    const operand = { ...input, values: paperZeros(input.values, derivation) }
    if (input.pending !== undefined) {
      // The caller starts the smoothing from the operand's `pending`; this
      // comes back through here once it has landed.
      this.forgetCorrelation()
      return operand
    }
    this.startCorrelation(key, input, operand, data.nrows)
    return operand
  }

  /** Ask for one, with the operand drawn meanwhile. */
  private startCorrelation(key: string, input: DerivedValues, operand: DerivedValues, n: number): void {
    const run = this.options.derive?.correlateBlock
    if (run === undefined) return
    // The block moved under a job that is still running, so its answer is about
    // a square nobody is looking at.
    this.correlating?.job.cancel()

    const job = run(input.values, n, (done, total) => {
      if (this.correlating?.key !== key) return
      this.showCorrelating(`correlating… ${Math.round((100 * done) / Math.max(1, total))}%`)
    })
    this.correlating = { key, job, operand }
    this.showCorrelating('correlating…')
    // What was correlated, said by the derivation that made it.
    const { label, scope } = input

    job.promise.then(
      (field) => {
        // A late answer to a superseded question. Dropped rather than cached:
        // the key it belongs to may never be asked for again, and holding it
        // would mean the cache answered for a block that is no longer read.
        if (this.correlating?.key !== key) return
        this.correlating = null
        this.correlation = { key, field, label, scope }
        this.showCorrelating(null)
        this.host.redraw()
      },
      (err: unknown) => {
        if (this.correlating?.key !== key) return
        this.correlating = null
        this.showCorrelating(null)
        // A cancelled correlation is a reader who moved on, which is not an
        // error and must not draw one (`worker/client.ts`).
        if (!isCancellation(err)) {
          this.options.derive?.onCorrelateChange?.(false)
          this.options.derive?.onCorrelateFailure?.(
            err instanceof Error ? err.message : String(err),
          )
        }
      },
    )
  }

  /** Put the correlation's own wait on the veil, or take it off. */
  private showCorrelating(note: string | null): void {
    this.correlationNote = note
    this.refreshBusy()
  }

  /** Put the smoothing's wait on the veil, or take it off. */
  private showSmoothing(note: string | null): void {
    this.smoothingNote = note
    this.refreshBusy()
  }

  /**
   * Whichever wait is outstanding, with the correlation's winning.
   *
   * Both can be outstanding at once — the smoothing runs before the correlation
   * does — and two notes cannot share one veil. The correlation's is shown
   * because it is the longer job and the one whose progress a reader is actually
   * waiting on.
   */
  private refreshBusy(): void {
    const note = this.correlationNote ?? this.smoothingNote
    if (note === null) this.host.setBusy(false)
    else this.host.setBusy(true, note)
  }

  /** Drop any held or running correlation — the block it was about has gone. */
  private forgetCorrelation(): void {
    this.correlating?.job.cancel()
    this.correlating = null
    this.correlation = null
    this.showCorrelating(null)
  }

  /** The same for a smoothing, and it is dropped on the same events. */
  private forgetSmoothing(): void {
    this.smoothing?.job.cancel()
    this.smoothing = null
    this.smoothed = null
    this.showSmoothing(null)
  }

  /**
   * Ask for a smoothing, unless the same one is already on its way.
   *
   * `startCorrelation`'s shape throughout, including the two things easy to leave
   * out: a superseded job is cancelled rather than left to finish for a block
   * nobody is looking at, and a late answer to a superseded question is dropped
   * rather than cached, because the key it belongs to may never be asked for
   * again.
   */
  private startSmoothing(key: string, request: SmoothingRequest): void {
    if (this.smoothing?.key === key) return
    const run = this.options.derive?.smoothBlock
    if (run === undefined) return
    this.smoothing?.job.cancel()

    const job = run(request)
    this.smoothing = { key, job }
    this.showSmoothing('smoothing…')

    job.promise.then(
      (field) => {
        if (this.smoothing?.key !== key) return
        this.smoothing = null
        this.smoothed = { key, field }
        this.showSmoothing(null)
        this.host.redraw()
      },
      (err: unknown) => {
        if (this.smoothing?.key !== key) return
        this.smoothing = null
        this.showSmoothing(null)
        // A cancelled smoothing is a reader who moved the picker, which is not an
        // error and must not draw one (`worker/client.ts`). A real failure leaves
        // the unsmoothed map standing, a true picture of the same region.
        if (!isCancellation(err)) {
          this.options.derive?.onCorrelateFailure?.(
            err instanceof Error ? err.message : String(err),
          )
        }
      },
    )
  }

  /**
   * What identifies the block a smoothing was computed for.
   *
   * Everything upstream of it in `deriveBlock`'s pipeline, and the baseline
   * through `expected`: a window sized against one normalisation is not the
   * window another would have chosen, and the O/E decides whether a second field
   * was averaged alongside the first at all.
   */
  private smoothingKey(data: MatrixResult, derivation: Derivation): string {
    return [
      this.blockGeneration,
      data.nrows,
      data.ncols,
      data.rowExtent[0],
      data.rowExtent[1],
      data.colExtent[0],
      data.colExtent[1],
      derivation.normalise ?? '',
      String(derivation.expected === true),
      String(derivation.baseline === true),
      derivation.smooth ?? '0',
      armsKey(armsInForce(this.options.derive)),
    ].join('|')
  }

  /**
   * Cancel whatever is running and forget whatever is held: the panel is going
   * away ({@link MatrixPanel.destroy}).
   */
  destroy(): void {
    this.forgetCorrelation()
    this.forgetSmoothing()
  }
}
