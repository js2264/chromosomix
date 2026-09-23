/**
 * Compartments, run: expected → observed/expected → correlation → eigenvectors,
 * then phasing, then the saddle.
 *
 * Everything mathematical is in `analysis/compartments.ts` and
 * `analysis/linalg.ts`. What is here is the chain, the places it can refuse, and
 * the two things neither kernel can do for itself — **assembling the square** a
 * set of ticked sequences implies, and building the *signal* a component's sign
 * is attached to, which means reading a gene model or a FASTA's GC content over
 * the same bins.
 *
 * ## One correlation over the ticked sequences, cis and trans
 *
 * The reader ticks sequences and gets **one** eigenvector over all of them,
 * computed from a square that holds their cis blocks *and* the trans blocks
 * between them. That is a different quantity from the per-chromosome one and not
 * an average of it: two chromosomes in the same compartment touch each other in
 * trans, and it is exactly that signal a genome-wide E1 is carried by. Ticking
 * one sequence gives the per-chromosome answer, which is the degenerate case of
 * the same arithmetic rather than a second code path.
 *
 * The expectation is where cis and trans part company, and
 * {@link ExpectedPlan} is the whole of it: a cis cell is divided by its own
 * sequence's decay at that separation — never a pooled curve, which would divide
 * a small chromosome by the average behaviour of the large ones and show up as a
 * gradient along the eigenvector — and a trans cell, which has no separation at
 * all, is divided by the mean of its own pair's block.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import { contextOf } from '../../genome/naming'
import type { FeatureSet } from '../../annotations/types'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { DEFAULT_DIVERGING_COLORMAP } from '../../render/colormaps'
import { armExpected, type ArmFrame } from '../arms'
import {
  cisSeparation,
  compartmentSegments,
  correlationMatrix,
  observedOverExpected,
  phaseComponent,
  saddle,
  usableBins,
  type ExpectedPlan,
  type Phasing,
} from '../compartments'
import { ExpectedAccumulator } from '../expected'
import {
  boolParam,
  chosenInput,
  contigIdsFor,
  idParam,
  numParam,
  originOf,
  readsAsCircular,
  strParam,
  tickedSequences,
  type JobContext,
  type TaskRunner,
} from '../job'
import type { Params } from '../types'
import { leadingEigenpairs, type Eigenpair } from '../linalg'
import { pearson } from '../stats'
import { MAX_CORRELATION_BINS } from '../tasks/compartments'
import type { MatrixOutput, ProfileOutput, TableOutput, TaskOutput } from '../types'
import { displayableContigs, usableBlock, type Span } from './blocks'

/**
 * The fraction of a bin's row that must carry data for it to take part.
 *
 * A constant rather than a control. It was one, in a *Quality* section beside
 * the balancing tickbox, and neither belonged there: this is the threshold below
 * which a row of the correlation matrix is noise, not a knob anybody sweeps to
 * change an answer — moving it does not produce a different reading of the
 * chromosome, it produces the same reading with more or less rubbish in it. The
 * bins it drops are named in a note either way, which is the part a reader
 * actually needs.
 */
const MIN_COVERAGE = 0.1

/**
 * The square a set of ticked sequences implies.
 *
 * `bin` and `group` are the two arrays everything downstream reads: which file
 * bin each row of the square is, and which ticked sequence it belongs to. The
 * groups are **contiguous runs** of the square by construction, which is what
 * lets a cis separation be `|col − row|` rather than needing a lookup per cell.
 *
 * `spans` is the *coalesced* form, and it is what makes the common case cheap:
 * every sequence ticked coalesces to one run over the whole file and reads as one
 * block, while a scattered subset reads one rectangle per pair. Adjacent ticked
 * sequences coalesce too, so ticking chromosomes I–IV is one read and not ten.
 */
interface Selection {
  /** Ticked contig ids, in file order. */
  contigs: number[]
  /** Coalesced runs of absolute bins, ascending and non-touching. */
  spans: Span[]
  /** Where each span starts in the square. */
  spanAt: number[]
  /** Absolute file bin of each row of the square; `n` long. */
  bin: Int32Array
  /** Index into {@link contigs} for each row of the square; `n` long. */
  group: Int32Array
  n: number
}

/**
 * The ticked sequences, as a square to read.
 *
 * A contig with no bins is dropped rather than made into an empty group: an
 * `ExpectedAccumulator` of zero length and a trans block with no cells are two
 * ways to get a `NaN` into the plan for a sequence the reader ticked and cannot
 * see anything wrong with.
 *
 * **The names are not necessarily this file's.** They are the *starred* map's —
 * the form ticks every sequence of whichever file the Analysis column is
 * pointed at — and a batch then runs the same list against every panel of the
 * deck (§18.2). Matched by string, a `.hic` writing `1` beside a `.cool` writing
 * `chr1` matched nothing at all and the run ended on *none of the ticked
 * sequences has any bins in it*, which is true and is not the reason. So they go
 * through {@link contigIdsFor}, with the ticked list itself standing in for the
 * naming context: it *is* the source file's spellings, so it is the thing that
 * says whether its numerals are Roman (§5.9).
 */
function selectionOf(job: JobContext, names: readonly string[]): Selection {
  const { ids } = contigIdsFor(job.mc, names, contextOf(names as string[]))
  const contigs: number[] = []
  // Ascending, which {@link contigIdsFor} guarantees: the square's rows are laid
  // out in file order, and the groups are contiguous runs of it by construction.
  for (const cid of ids) {
    const [from, to] = job.mc.contigExtent(cid)
    if (to > from) contigs.push(cid)
  }

  let n = 0
  const bins: number[] = []
  const group: number[] = []
  for (let g = 0; g < contigs.length; g++) {
    const [from, to] = job.mc.contigExtent(contigs[g])
    for (let bin = from; bin < to; bin++) {
      bins.push(bin)
      group.push(g)
    }
    n += to - from
  }

  // Coalesced *after* the rows are laid out, so the square's order is the file's
  // whatever the runs turn out to be.
  const spans: Span[] = []
  const spanAt: number[] = []
  for (let i = 0; i < bins.length; i++) {
    const last = spans[spans.length - 1]
    if (last !== undefined && bins[i] === last.to) {
      last.to++
      continue
    }
    spanAt.push(i)
    spans.push({ from: bins[i], to: bins[i] + 1 })
  }

  return { contigs, spans, spanAt, bin: Int32Array.from(bins), group: Int32Array.from(group), n }
}

/**
 * The square itself: every ticked bin against every other, cis and trans.
 *
 * From the view's own block where it covers the lot — the common case, since a
 * reader usually presses **Run** while looking at the thing they want measured —
 * and otherwise one dense read per pair of coalesced runs. Pairs rather than one
 * covering read, because a covering read over a scattered selection is the whole
 * genome: ticking chromosomes I and XVI would otherwise read everything between
 * them and throw it away.
 *
 * Both triangles are filled from each read. `mc.matrix` answers a rectangle
 * honestly whichever side of the diagonal it is on, so the mirror is a transpose
 * of what was read rather than a second request.
 */
async function readSquare(
  job: JobContext,
  selection: Selection,
  options: { balance: boolean; value: string },
): Promise<Float32Array> {
  const { spans, spanAt, n } = selection
  const out = new Float32Array(n * n).fill(Number.NaN)
  const block = usableBlock(job, spans, options.balance)
  const reads = (spans.length * (spans.length + 1)) / 2
  let done = 0

  const place = (
    values: Float32Array,
    ncols: number,
    rowSpan: number,
    colSpan: number,
  ): void => {
    const rows = spans[rowSpan].to - spans[rowSpan].from
    const cols = spans[colSpan].to - spans[colSpan].from
    const rowAt = spanAt[rowSpan]
    const colAt = spanAt[colSpan]
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const value = values[r * ncols + c]
        out[(rowAt + r) * n + colAt + c] = value
        out[(colAt + c) * n + rowAt + r] = value
      }
    }
  }

  for (let i = 0; i < spans.length; i++) {
    for (let j = i; j < spans.length; j++) {
      job.throwIfCancelled()
      job.progress(done, reads, 'reading')
      done++
      if (block !== null) {
        // The block is dense over its own extents, so the two runs index into it
        // directly — no request, and no copy of anything but the cells wanted.
        const rowSkip = spans[i].from - block.rowExtent[0]
        const colSkip = spans[j].from - block.colExtent[0]
        const rows = spans[i].to - spans[i].from
        const cols = spans[j].to - spans[j].from
        const cut = new Float32Array(rows * cols)
        for (let r = 0; r < rows; r++) {
          const at = (rowSkip + r) * block.ncols + colSkip
          cut.set(block.values.subarray(at, at + cols), r * cols)
        }
        place(cut, cols, i, j)
        continue
      }
      const dense = await job.mc.matrix({
        rows: [spans[i].from, spans[i].to],
        cols: [spans[j].from, spans[j].to],
        balance: options.balance,
        value: options.value,
      })
      place(dense.values, dense.ncols, i, j)
    }
  }
  return out
}

/**
 * What each cell is divided by: a decay curve per sequence, a mean per pair.
 *
 * Accumulated from the square that is already in hand rather than from the P(s)
 * task, and that is not a shortcut — an O/E over one chromosome wants that
 * chromosome's own decay, and the whole-file curve is a different denominator.
 */
function planExpected(
  values: Float32Array,
  selection: Selection,
  laps: Int32Array,
): ExpectedPlan {
  const { group, n } = selection
  const k = selection.contigs.length
  const starts: number[] = []
  const ends: number[] = []
  for (let g = 0; g < k; g++) {
    starts.push(group.indexOf(g))
    ends.push(group.lastIndexOf(g) + 1)
  }

  const cis = starts.map((start, g) => {
    const length = ends[g] - start
    // A circle's longest separation is half of it, measured the short way
    // round (§8.15) — the same rule `observedOverExpected` reads it back with.
    const lap = laps[g]
    const accumulator = new ExpectedAccumulator(
      lap > 0 ? Math.floor(length / 2) : Math.max(0, length - 1),
      lap,
    )
    for (let r = start; r < ends[g]; r++) {
      for (let c = start; c < ends[g]; c++) {
        accumulator.add(cisSeparation(Math.abs(c - r), lap), values[r * n + c])
      }
    }
    return accumulator.finish()
  })

  const trans = new Float64Array(k * k).fill(Number.NaN)
  for (let a = 0; a < k; a++) {
    for (let b = a + 1; b < k; b++) {
      let total = 0
      let seen = 0
      for (let r = starts[a]; r < ends[a]; r++) {
        for (let c = starts[b]; c < ends[b]; c++) {
          const value = values[r * n + c]
          if (!Number.isFinite(value)) continue
          total += value
          seen++
        }
      }
      // The mean of the pair's own block. `NaN` where the pair has nothing in it
      // at all, which `observedOverExpected` reads as *no expectation* and
      // answers with a gap rather than with the raw count.
      const mean = seen === 0 ? Number.NaN : total / seen
      trans[a * k + b] = mean
      trans[b * k + a] = mean
    }
  }

  return {
    group,
    cis,
    trans,
    contacts: 'both',
    ignoreDiags: 0,
    ...(laps.some((lap) => lap > 0) ? { laps } : {}),
  }
}

/**
 * Bins per sequence of the square where it is read as a circle, `0` otherwise.
 *
 * Only a sequence the square holds **whole** can be read round: the plan's cis
 * separation is `|col − row|` within a group, which is the circle's only when the
 * group is the circle from its first bin to its last — which `selectionOf`
 * guarantees by taking whole sequences.
 */
function lapsOf(job: JobContext, selection: Selection): Int32Array {
  const laps = new Int32Array(selection.contigs.length)
  for (let g = 0; g < selection.contigs.length; g++) {
    const cid = selection.contigs[g]
    if (!readsAsCircular(job, job.mc.chromnames[cid])) continue
    const [from, to] = job.mc.contigExtent(cid)
    laps[g] = to - from
  }
  return laps
}

/**
 * Observed over the **arm-frame** expectation (`analysis/arms.ts`), over the
 * usable bins — the square with both of a bacterial chromosome's diagonals
 * divided out, rather than the main one alone.
 *
 * One sequence, always: the arms are a fact about one molecule, and the mode is
 * offered only where the run is one square per sequence. The near-diagonal is
 * left out on the same rule, and a cell is a gap on the same conditions, as in
 * `observedOverExpected` — the only thing that differs is the denominator.
 */
function armsObservedOverExpected(
  values: Float32Array,
  n: number,
  index: Int32Array,
  frame: ArmFrame,
  window: number,
  ignoreDiags: number,
): Float64Array {
  const bins = Int32Array.from({ length: n }, (_, i) => i)
  const expected = armExpected(values, bins, bins, frame, window)
  const m = index.length
  const lap = frame.circular ? n : 0
  const out = new Float64Array(m * m)
  for (let r = 0; r < m; r++) {
    const row = index[r]
    for (let c = 0; c < m; c++) {
      const col = index[c]
      if (cisSeparation(Math.abs(col - row), lap) < ignoreDiags) {
        out[r * m + c] = Number.NaN
        continue
      }
      const observed = values[row * n + col]
      const denominator = expected[row * n + col]
      out[r * m + c] =
        Number.isFinite(observed) && Number.isFinite(denominator) && denominator !== 0
          ? observed / denominator
          : Number.NaN
    }
  }
  return out
}

/**
 * The arms of the one sequence in a square: its bins, where its origin falls,
 * and whether it is a circle.
 *
 * The origin is the one declared for the sequence (`AnalysisFraming.origins`),
 * which the *Origin and terminus* task fills in and the Chromosomes table shows.
 * With none, the first base stands in — where most assemblies of a bacterial
 * chromosome start, at `dnaA` — and the run says so, because arms measured from
 * the wrong place fold the map about the wrong line.
 */
function armFrameOf(
  job: JobContext,
  selection: Selection,
  laps: Int32Array,
  label: string,
): ArmFrame {
  const cid = selection.contigs[0]
  const name = job.mc.chromnames[cid]
  const declared = originOf(job, name)
  const binsize = job.mc.binsize
  if (declared === undefined) {
    job.note(
      `${label}: the arms were read from the first base, the origin every sequence has until one ` +
        'is set — on the Chromosomes table, or by Origin and terminus.',
    )
  }
  const at = declared ?? 0
  const origin = Math.max(0, Math.min(selection.n - 1, Math.floor(at / binsize)))
  job.note(
    `${label}: arms read from the origin at ${(at + 1).toLocaleString()} ` +
      `(bin ${origin.toLocaleString()}), ${laps[0] > 0 ? 'round the circle' : 'along the line'}.`,
  )
  return { n: selection.n, origin, circular: laps[0] > 0 }
}

/** Which contacts enter the correlation; see {@link ExpectedPlan.contacts}. */
function contactsOf(params: Params): 'cis' | 'trans' | 'both' {
  const value = params.contacts
  // The same fallback the descriptor makes, and it must be: one of them prices
  // what the other runs.
  return value === 'trans' || value === 'both' ? value : 'cis'
}

/**
 * One square, from reading it to the outputs it produced.
 *
 * The whole chain, run over whatever selection it is handed — every ticked
 * sequence at once, or one of them. `null` where this square produced nothing,
 * and every one of those paths leaves a note naming the selection: a chromosome
 * silently missing from a genome-wide track is the failure this could most
 * easily have.
 *
 * The eigenvectors are written into `tracks` rather than returned, because a
 * track is a track: E1 of chromosome IV and E1 of chromosome V are the same
 * quantity on two stretches of one axis, and two rows on the Synthetic tracks
 * card saying `E1 · IV` and `E1 · V` would be a card the reader reassembles by
 * eye.
 */
async function runSquare(
  job: JobContext,
  selection: Selection,
  options: {
    contacts: 'cis' | 'trans' | 'both'
    ignoreDiags: number
    wanted: number
    tracks: Float32Array[]
    segments: FeatureBuilder
    label: string
    /** Reported as `done of total` while several squares are being run. */
    step: { at: number; of: number }
    /**
     * Divide by the arm-frame expectation rather than the distance decay, with
     * this half-width along the arms in bins (`0` the whole sequence). Only for
     * a square of one sequence; absent is the ordinary observed/expected.
     */
    arms?: { window: number }
    /** Rank the components by how well they follow the phasing signal (§18.8). */
    orderByPhasing: boolean
    /** One row per component, for the components table. */
    rows: Array<Record<string, string | number>>
  },
): Promise<{ saddle: MatrixOutput | null } | null> {
  const { label } = options
  const balance = boolParam(job.params, 'balance', true)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const square = await readSquare(job, selection, { balance, value })
  job.throwIfCancelled()

  const laps = lapsOf(job, selection)
  const plan: ExpectedPlan = {
    ...planExpected(square, selection, laps),
    contacts: options.contacts,
    ignoreDiags: options.ignoreDiags,
  }
  const index = usableBins(square, selection.n, MIN_COVERAGE)
  if (index.length < 8) {
    job.note(
      `${label}: only ${index.length} bins carry enough data to correlate, which is too few for ` +
        'a component to mean anything.',
    )
    return null
  }
  if (index.length < selection.n) {
    job.note(
      `${label}: ${(selection.n - index.length).toLocaleString()} of ` +
        `${selection.n.toLocaleString()} bins were left out for want of data. They are gaps in ` +
        'the track rather than zeros.',
    )
  }

  const oe =
    options.arms !== undefined && selection.contigs.length === 1
      ? armsObservedOverExpected(
          square,
          selection.n,
          index,
          armFrameOf(job, selection, laps, label),
          options.arms.window,
          options.ignoreDiags,
        )
      : observedOverExpected(square, selection.n, index, plan)
  job.throwIfCancelled()

  // A mode and a diagonal cut can between them leave nothing to correlate — a
  // cis-only square whose sequence is shorter than `ignoreDiags` is the case
  // that reaches a reader, since the control has no upper bound and a
  // metagenome's sequences are short. Every cell being a gap makes every
  // correlation undefined, which `correlationMatrix` reads as *no evidence* and
  // fills with zeros, and the leading eigenvector of a zero matrix is a shape
  // with no data behind it. Named, rather than drawn.
  let finite = 0
  for (const value of oe) if (Number.isFinite(value)) finite++
  if (finite === 0) {
    job.note(
      `${label}: nothing was left to correlate — ${plan.ignoreDiags} ignored ` +
        `${plan.ignoreDiags === 1 ? 'diagonal covers' : 'diagonals cover'} the whole of a ` +
        `${selection.n.toLocaleString()}-bin square. Ignore fewer.`,
    )
    return null
  }

  // Cubic in the bin count, and the one step of the chain that is — so it
  // reports where it has got to and can be stopped from inside its own loop.
  const correlation = await correlationMatrix(oe, index.length, async (row) => {
    // Every sixty-fourth row rather than every row: a `breathe` is a
    // `MessageChannel` round trip, and this is the loop that most needs to be
    // stoppable *and* the one that would most notice paying for it `m` times.
    // Between breaths the flag cannot have changed, so the synchronous check is
    // the one that matters in between and the yield is what makes it able to.
    if (row % 64 !== 0) {
      job.throwIfCancelled()
      return
    }
    await job.breathe()
    job.progress(options.step.at, options.step.of, `correlating ${label}`)
  })

  const signal = phasingSignal(job, selection, index)
  // Ranking by the phasing signal chooses among the first three whatever the
  // number drawn, so the one that follows the signal can come from behind a
  // component the variance put first.
  const ranked = options.orderByPhasing && signal !== null
  if (options.orderByPhasing && signal === null) {
    job.note(`${label}: nothing was chosen to phase against, so the components keep their order by variance.`)
  }

  // The correlation matrix is consumed in place by the deflation, so the saddle
  // below uses `oe` — which is the matrix it wants anyway.
  const computed = leadingEigenpairs(
    correlation,
    index.length,
    ranked ? Math.max(3, options.wanted) : options.wanted,
  )
  if (computed.length === 0) {
    job.note(`${label}: the correlation matrix has no leading component; it may be too sparse.`)
    return null
  }
  // What each component explained and how it followed the signal, before any
  // reordering, so the table can say which was chosen and why.
  const described = computed.map((pair, rank) => ({
    pair,
    rank,
    // A correlation matrix has ones on its diagonal, so its trace is the number
    // of rows and an eigenvalue over that is the share of the variance.
    explained: pair.value / index.length,
    r: signal === null ? Number.NaN : pearson(pair.vector, signal.values),
  }))
  const order = ranked
    ? [...described].sort((a, b) => Math.abs(b.r) - Math.abs(a.r) || a.rank - b.rank)
    : described
  const pairs: Eigenpair[] = order.slice(0, options.wanted).map((entry) => entry.pair)
  for (let k = 0; k < order.length; k++) {
    options.rows.push({
      sequence: label,
      component: `E${order[k].rank + 1}`,
      drawn: k < options.wanted ? `E${k + 1}` : '',
      explained: order[k].explained,
      r: order[k].r,
    })
  }
  if (ranked && order[0].rank !== 0) {
    job.note(
      `${label}: the component that follows ${signal.name} best is the one the variance ranked ` +
        `E${order[0].rank + 1} (r = ${fmt(order[0].r)}), so it is drawn as E1.`,
    )
  }

  let phased: Phasing | null = null

  for (let component = 0; component < pairs.length && component < options.tracks.length; component++) {
    const vector = pairs[component].vector
    if (signal !== null) {
      const result = phaseComponent(vector, signal, numParam(job.params, 'minR', 0.1))
      if (component === 0) {
        phased = result
        job.note(
          result.confident
            ? `${label}: E1 phased against ${result.signal} (r = ${fmt(result.r)})` +
                `${result.flipped ? ', sign flipped' : ''}.`
            : `${label}: phasing against ${result.signal} was ambiguous (r = ${fmt(result.r)}), ` +
                'so E1’s sign is arbitrary and should not be compared with another run.',
        )
      }
    } else if (component === 0) {
      job.note('Nothing was chosen to phase against, so the sign of each component is arbitrary.')
    }

    // Back over the full bin grid, with every bin that took no part restored as
    // a gap — which is the whole reason the chain worked over an index (§18.8).
    const track = options.tracks[component]
    for (let i = 0; i < index.length; i++) track[selection.bin[index[i]]] = vector[i]
  }

  addCompartmentSegments(job, options.segments, selection, index, pairs[0].vector)

  if (!boolParam(job.params, 'saddle', true)) return { saddle: null }
  const bins = Math.max(5, Math.min(100, Math.round(numParam(job.params, 'quantiles', 50))))
  const result = saddle(oe, index.length, pairs[0].vector, bins)
  return {
    saddle: {
      kind: 'matrix',
      id: `compartment-saddle-${label}`,
      label: `Saddle · ${label}`,
      nrows: bins,
      ncols: bins,
      values: result.values,
      xLabel: 'E1 quantile',
      yLabel: 'E1 quantile',
      xTicks: [],
      yTicks: [],
      colormap: DEFAULT_DIVERGING_COLORMAP,
      centre: 1,
      stats: [
        { label: 'AA', value: result.strength.aa, digits: 2 },
        { label: 'BB', value: result.strength.bb, digits: 2 },
        { label: 'AB', value: result.strength.ab, digits: 2 },
        ...(phased === null || phased.confident
          ? []
          : [
              {
                label: 'phasing r',
                value: phased.r,
                digits: 2,
                hint: 'Too weak to fix the sign, so AA and BB may be the wrong way round.',
              },
            ]),
      ],
    } satisfies MatrixOutput,
  }
}

export const runCompartments: TaskRunner = async (job) => {
  // **Unanswered is every sequence, and `[]` is none of them** (§18.2). The two
  // used to be one: `listParam` reads anything that is not an array as `[]`, so
  // a job that never met a form — `metacooler-run compartments file.cool` — was
  // told to tick a box in a drawer it has not got.
  const ticked = tickedSequences(job.params, 'sequences')
  const names =
    ticked ?? displayableContigs(job.mc).map((cid) => job.mc.chromnames[cid])
  if (names.length === 0) {
    job.note('No sequence is ticked, so there is nothing to correlate.')
    return []
  }
  // Said out loud, and before the run rather than after it. A ticked sequence
  // this file has not got is not an error — a deck holds files of different
  // assemblies on purpose, and a batch asks each of them for the same list — but
  // a run that quietly drops half of what was asked for and reports a clean
  // eigenvector is the one failure §5.9 exists to prevent. Named up to a handful
  // so the note stays a sentence.
  const missing = contigIdsFor(job.mc, names, contextOf(names)).missing
  if (missing.length > 0 && missing.length < names.length) {
    const shown = missing.slice(0, 6).join(', ')
    job.note(
      `${missing.length} of the ${names.length} ticked ${missing.length === 1 ? 'sequence is' : 'sequences are'} ` +
        `not in this file and ${missing.length === 1 ? 'was' : 'were'} left out: ` +
        `${shown}${missing.length > 6 ? ', …' : ''}.`,
    )
  }
  const whole = selectionOf(job, names)
  if (whole.n === 0) {
    job.note(
      `None of the ${names.length} ticked ${names.length === 1 ? 'sequence' : 'sequences'} is in ` +
        `this file, under that spelling or any this viewer knows of. It has ` +
        `${job.mc.chromnames.slice(0, 6).join(', ')}${job.mc.chromnames.length > 6 ? ', …' : ''}.`,
    )
    return []
  }

  const contacts = contactsOf(job.params)
  if (contacts === 'trans' && whole.contigs.length < 2) {
    throw new Error(
      'A trans correlation is between sequences, so it needs at least two ticked. Tick more, ' +
        'or read this one’s cis contacts instead.',
    )
  }

  /**
   * **Cis-only is one square per sequence; the other two are one square.**
   *
   * Not a preference. A single square with its trans blocks removed has no
   * finite cell shared between a row of chromosome IV and a row of chromosome V,
   * so every correlation across that boundary is undefined and enters the matrix
   * as a zero — leaving it block-diagonal, and the leading eigenvector of a
   * block-diagonal matrix lives entirely inside whichever block has the largest
   * eigenvalue and is zero on all the others. A genome-wide cis-only run done
   * that way returns one chromosome's compartments and fifteen flat lines, which
   * is wrong in a way that looks like data.
   *
   * So cis-only loops, exactly as somebody would by hand, and each pass is the
   * per-chromosome run in full. It is also the cheaper shape by a long way — the
   * correlation is cubic, so sixteen squares of 1,500 bins is a fraction of one
   * of 24,000 — which is what makes cis-only the mode that works at a fine
   * resolution.
   */
  const squares =
    contacts === 'cis'
      ? whole.contigs.map((cid) => selectionOf(job, [job.mc.chromnames[cid]]))
      : [whole]

  // cooltools' `ignore_diags`, and its arithmetic: `|col - row| < ignoreDiags`.
  const ignoreDiags = Math.max(0, Math.round(numParam(job.params, 'ignoreDiags', 2)))
  const wanted = Math.max(1, Math.min(3, Math.round(numParam(job.params, 'components', 1))))
  const tracks: Float32Array[] = []
  for (let i = 0; i < wanted; i++) tracks.push(new Float32Array(job.mc.nBins).fill(Number.NaN))
  const segments = new FeatureBuilder()
  const outputs: TaskOutput[] = []
  const rows: Array<Record<string, string | number>> = []
  // The arm-frame expectation is offered in cis alone, where every square is
  // one sequence; a stored recipe naming it under another mode is read as the
  // mode it names, which has one expectation per cell and no arms.
  const arms =
    contacts === 'cis' && strParam(job.params, 'expected', 'distance') === 'arms'
      ? { window: Math.max(0, Math.round(numParam(job.params, 'armWindow', 50))) }
      : undefined
  if (arms !== undefined) {
    job.note(
      arms.window === 0
        ? 'Divided by the decay along both arms, over the whole of each chromosome.'
        : `Divided by the decay along both arms, within ${arms.window.toLocaleString()} bins ` +
            `(${(arms.window * job.mc.binsize).toLocaleString()} bp) of each cell along them.`,
    )
  }
  const orderByPhasing = strParam(job.params, 'order', 'variance') === 'phasing'
  let ran = 0

  for (let s = 0; s < squares.length; s++) {
    await job.breathe()
    const selection = squares[s]
    const label = describe(job, selection)
    if (selection.n > MAX_CORRELATION_BINS) {
      const message =
        `${label} is ${selection.n.toLocaleString()} bins, past the ` +
        `${MAX_CORRELATION_BINS.toLocaleString()}-bin limit on a correlation matrix`
      // Naming one sequence and being refused is a refusal — the reader asked
      // for that and got nothing. Meeting one in a sweep is not a reason to
      // throw away the others.
      if (squares.length === 1) {
        throw new Error(`Refusing to build it: ${message}. Untick some, or open the file coarser.`)
      }
      job.note(`${message}, so it was skipped. Open the file at a coarser resolution to include it.`)
      continue
    }
    job.progress(s, squares.length, `compartments on ${label}`)
    const done = await runSquare(job, selection, {
      contacts,
      ignoreDiags,
      wanted,
      tracks,
      segments,
      label,
      step: { at: s, of: squares.length },
      ...(arms === undefined ? {} : { arms }),
      orderByPhasing,
      rows,
    })
    if (done === null) continue
    ran++
    if (done.saddle !== null) outputs.push(done.saddle)
  }

  if (ran === 0) {
    job.note('Nothing produced a component. See the notes above.')
    return []
  }

  // The tracks first, then the calls, then the pictures: a reader scanning the
  // drawer meets the thing they will keep before the thing they will look at.
  const label = `${describe(job, whole)} · ${CONTACT_WORDS[contacts]}${arms === undefined ? '' : ' · arms'}`
  // What every component explained and how it followed the phasing signal —
  // the table that says which one is the compartment track, and why E1 is the
  // one drawn as E1.
  outputs.push({
    kind: 'table',
    id: 'compartment-components',
    label: `Components · ${label}`,
    columns: [
      { key: 'sequence', label: 'sequence', kind: 'text' },
      { key: 'component', label: 'component', kind: 'text', hint: 'By variance explained.' },
      { key: 'drawn', label: 'drawn as', kind: 'text' },
      {
        key: 'explained',
        label: 'variance',
        kind: 'number',
        digits: 3,
        hint: 'Share of the correlation matrix’s variance: its eigenvalue over its rows.',
      },
      {
        key: 'r',
        label: 'r with phasing',
        kind: 'number',
        digits: 3,
        hint: 'Pearson’s r with the phasing signal, before the sign was fixed.',
      },
    ],
    rows,
  } satisfies TableOutput)
  outputs.unshift(
    ...tracks.map(
      (values, i) =>
        ({
          kind: 'profile',
          id: `compartment-e${i + 1}`,
          label: `E${i + 1} · ${label}`,
          values,
          extent: [0, job.mc.nBins],
          binsize: job.mc.binsize,
          unit: '',
        }) satisfies ProfileOutput,
    ),
    {
      kind: 'intervals',
      id: 'compartment-ab',
      label: `A/B compartments · ${label}`,
      payload: { kind: 'features', data: segments.finish() },
      // Segments and not compartments: there are two compartments and several
      // hundred stretches of them, and the number worth reporting is the second.
      noun: { one: 'segment', many: 'segments' },
    },
  )

  job.progress(squares.length, squares.length, 'done')
  return outputs
}

/** How each mode is named on a lane label and in a provenance line. */
const CONTACT_WORDS: Record<'cis' | 'trans' | 'both', string> = {
  cis: 'cis',
  trans: 'trans',
  both: 'cis + trans',
}

/**
 * What to call this run: the sequence, or how many of them.
 *
 * One name where one sequence was ticked, because that is what a reader would
 * write on it; a count otherwise, because sixteen names on a lane label is not a
 * label. "Genome-wide" is reserved for the case where it is true.
 */
function describe(job: JobContext, selection: Selection): string {
  const k = selection.contigs.length
  if (k === 1) return job.mc.chromnames[selection.contigs[0]]
  const total = job.mc.chromnames.length
  return k === total ? 'genome-wide' : `${k.toLocaleString()} of ${total.toLocaleString()} sequences`
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '—'
}

/**
 * The A/B call, as a `FeatureSet` the Annotations panel can draw and a BED can
 * carry.
 *
 * The arithmetic is `compartmentSegments`, run **per sequence**: a run of one
 * sign cannot cross a chromosome boundary, and feeding it the whole selection at
 * once would join the last bin of one to the first of the next wherever they
 * happened to agree — a segment spanning two chromosomes, which is not a thing.
 */
function addCompartmentSegments(
  job: JobContext,
  builder: FeatureBuilder,
  selection: Selection,
  index: Int32Array,
  vector: Float64Array,
): void {
  const binsize = job.mc.binsize
  for (let g = 0; g < selection.contigs.length; g++) {
    const cid = selection.contigs[g]
    const name = job.mc.chromnames[cid]
    const [from] = job.mc.contigExtent(cid)
    // The sequence's own length, so the last segment stops where the chromosome
    // does rather than at the end of a bin that runs past it.
    const length = job.mc.chromsizes.get(name) ?? Number.POSITIVE_INFINITY
    const rows: number[] = []
    const values: number[] = []
    for (let i = 0; i < index.length; i++) {
      if (selection.group[index[i]] !== g) continue
      rows.push(selection.bin[index[i]])
      values.push(vector[i])
    }
    if (rows.length === 0) continue
    for (const segment of compartmentSegments(Int32Array.from(rows), Float64Array.from(values))) {
      builder.add(
        name,
        (segment.from - from) * binsize,
        Math.min(length, (segment.to - from + 1) * binsize),
        {
          name: segment.side,
          score: segment.mean,
          detail: `E1 mean ${segment.mean.toFixed(3)} · ${segment.bins} bins`,
        },
      )
    }
  }
}

/**
 * The signal a component's sign is attached to, over the bins that took part.
 *
 * A gene model first, because gene density is the conventional phasing signal
 * and the one a reader will recognise; a FASTA's GC content second, because it
 * is the fallback every tool offers and it needs no annotation at all. Both are
 * read over the ticked sequences and nothing else — which for a genome-wide run
 * is what makes one sign hold across all of them, rather than each chromosome
 * being phased against its own copy of the signal and drifting apart.
 *
 * **GC is not computed here, and it does not need to be.** The residues live in
 * the annotations worker and are megabytes; what this task wants is one number
 * per bin, which is exactly what that worker's `sample` already produces for the
 * lane it draws. So the main thread asks for the vector and ships it in
 * `inputs.vectors`, under the parameter's own key — the same channel a chosen
 * bigWig arrives on. That is why this file has no idea a FASTA was involved, and
 * why phasing by GC did not cost the task a third venue.
 */
function phasingSignal(
  job: JobContext,
  selection: Selection,
  index: Int32Array,
): { name: string; values: Float64Array } | null {
  // By the **parameter key**, `phaseFeatures`, exactly as the GC vector below is
  // read under `phaseSequence` — see `chosenInput`.
  const set = chosenInput(job.inputs.features, job.params, 'phaseFeatures').value
  if (set !== undefined) {
    return { name: 'gene density', values: densityOf(job, set, selection, index) }
  }

  // Any track — a bigWig or a synthetic one — arrives as a vector on the map's
  // bins, exactly as the GC content below does (`AnalysisRunner.inputsFor`).
  const trackId = idParam(job.params, 'phaseTrack')
  if (trackId !== null) {
    const vector = job.inputs.vectors?.['phaseTrack']
    if (vector === undefined) {
      job.note(
        'The track chosen for phasing could not be read, so it was not used. Load it again, or ' +
          'choose another.',
      )
    } else {
      const out = new Float64Array(index.length)
      for (let i = 0; i < index.length; i++) {
        const bin = selection.bin[index[i]]
        out[i] = bin >= 0 && bin < vector.length ? vector[bin] : Number.NaN
      }
      return { name: job.inputs.labels?.[trackId] ?? 'the chosen track', values: out }
    }
  }

  const sequenceId = idParam(job.params, 'phaseSequence')
  if (sequenceId === null) return null
  const gc = job.inputs.vectors?.['phaseSequence']
  if (gc === undefined) {
    // The row was dropped between the form being filled in and Run being
    // pressed, or the file has no sequence for these contigs. Named rather than
    // ignored: a component whose sign was left alone looks exactly like one that
    // was phased and came out this way round.
    job.note(
      'The sequence chosen for phasing could not be read, so the sign was left alone. ' +
        'Re-open the FASTA, or choose a gene model instead.',
    )
    return null
  }
  const out = new Float64Array(index.length)
  for (let i = 0; i < index.length; i++) {
    const bin = selection.bin[index[i]]
    out[i] = bin >= 0 && bin < gc.length ? gc[bin] : Number.NaN
  }
  return { name: 'GC content', values: out }
}

/** Features per bin, over the ticked sequences, in the order the index gives. */
function densityOf(
  job: JobContext,
  set: FeatureSet,
  selection: Selection,
  index: Int32Array,
): Float64Array {
  const perBin = new Float64Array(job.mc.nBins)
  for (const cid of selection.contigs) {
    const name = job.mc.chromnames[cid]
    const setContig = set.contigs.indexOf(name)
    if (setContig < 0) continue
    for (let i = 0; i < set.length; i++) {
      if (set.contig[i] !== setContig) continue
      // Every bin the feature covers, not only the one it starts in: a gene
      // spanning ten bins is evidence about ten bins, and counting only its
      // start would make density a picture of where genes begin.
      const first = job.mc.coords.binIndex(cid, set.start[i])
      const last = job.mc.coords.binIndex(cid, Math.max(set.start[i], set.end[i] - 1))
      for (let bin = first; bin <= last; bin++) {
        if (bin >= 0 && bin < perBin.length) perBin[bin] += 1
      }
    }
  }
  const out = new Float64Array(index.length)
  for (let i = 0; i < index.length; i++) out[i] = perBin[selection.bin[index[i]]]
  return out
}
