/**
 * P(s), computed: the worker-side half of `analysis/tasks/ps.ts`.
 *
 * The arithmetic itself is `analysis/expected.ts` and is not repeated here. What
 * this module owns is the part the kernel cannot know: **which cells belong in
 * which curve, and how to get hold of them at three very different prices.**
 *
 * The first of those is the one that is easy to get wrong. A P(s) is a *cis*
 * quantity — a separation in base pairs only means something between two loci on
 * the same sequence — so every cell that enters a curve has to come from a pair
 * of bins inside one contig. `ExpectedAccumulator.addBlock` files a cell by the
 * difference of its absolute bin indices and has no way to know where the
 * contigs are, so handing it a genome-wide block whole would file a contact
 * between the end of one contig and the start of the next as a short-range cis
 * contact. Everything below is therefore organised around a **span**: a run of
 * bins inside a single contig, which is the largest region a separation is
 * meaningful across. A curve is a named set of spans, and the three scopes
 * differ only in how the spans are grouped.
 *
 * The second is the price. §18.6's three cost classes are three code paths here,
 * and they are chosen in the order they cost:
 *
 * - the **block the view already holds**, sliced to each span — no I/O at all,
 *   and the common case, because the reader usually presses Run while looking at
 *   the thing they want measured;
 * - **one dense square**, when the answer is a single contig and the view is
 *   somewhere else;
 * - **one streaming pass over the pixel table**, for everything wider. Reading a
 *   square per contig instead would be one request per contig, which is 154 k of
 *   them on a real metagenome.
 *
 * The scan path carries one subtlety that decides whether the curve is P(s) at
 * all, and it is written out at {@link countPairs}: the pixel table holds only
 * the *non-zero* cells, so a denominator counted from the pixels would give the
 * mean strength of the contacts that exist rather than the probability that a
 * contact exists. The pairs are counted from the geometry instead.
 */

import { ViewerError } from '../../errors'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import {
  ExpectedAccumulator,
  densityCurve,
  logBinCurve,
  logLogSlope,
  type ExpectedCurve,
} from '../expected'
import {
  boolParam,
  numParam,
  readsAsCircular,
  strParam,
  tickedSequences,
  type JobContext,
  type TaskRunner,
} from '../job'
import {
  missingSequencesNote,
  spanOfContig,
  squareOf,
  tickedContigIds,
  usableBlock,
  validBins,
  type Span,
} from './blocks'
import type { CurveSeries, TaskOutput } from '../types'
import { binPairs } from '../../pairs/bin'
import { readPairsHeader } from '../../pairs/format'
import { orientationFigure, type OrientationCounts } from '../orientation'

// ---------------------------------------------------------------------------
// Spans and units
// ---------------------------------------------------------------------------

/** A half-open run of absolute bins lying inside one contig. */
/** One curve: a name for the legend, and the spans its cells come from. */
interface Unit {
  name: string
  spans: Span[]
  /** Bins in all its spans — how much evidence stands behind the curve. */
  bins: number
  /**
   * The longest separation any of its spans can reach.
   *
   * Taken from the *longest* span rather than from the total, because an offset
   * larger than a contig is an offset no pair of bins in it can be at: a genome
   * of two 400-bin contigs has separations up to 399, not up to 799.
   */
  maxOffset: number
  /**
   * Bins in the sequence, where this curve is of a **circular** one — `0`
   * otherwise (SPECS §8.15).
   *
   * Set only for a unit that is a single span covering a whole sequence the
   * reader has declared circular, which is the only shape the question has an
   * answer for: a genome-scope curve over four contigs of one MAG is not a
   * circle however many of those contigs are, and a curve over a *window* of a
   * sequence is a window whether or not the sequence joins its own ends.
   *
   * Two things follow, and both are in {@link makeUnit}: the longest separation
   * is half the sequence rather than all of it, because past half the circle the
   * short way round is the other way; and the pairs each separation could hold
   * are counted round the circle rather than along a line.
   */
  lap: number
}

function makeUnit(name: string, spans: Span[], lap = 0): Unit {
  let bins = 0
  let longest = 0
  for (const span of spans) {
    const length = span.to - span.from
    bins += length
    if (length > longest) longest = length
  }
  // Half the circle, and a line's `L − 1` otherwise. A circular curve that ran
  // to `L − 1` would plot the same cells twice, folded back on themselves — the
  // far half of it a mirror image of the near half, which is exactly the upturn
  // a circular chromosome scored as a line shows and which this is here to
  // remove rather than to reproduce.
  const circular = lap > 0 && spans.length === 1 && longest === lap
  return {
    name,
    spans,
    bins,
    maxOffset: circular ? Math.floor(lap / 2) : Math.max(0, longest - 1),
    lap: circular ? lap : 0,
  }
}


/**
 * The curves this run is going to produce — all of them.
 *
 * The scope switch normalises an unrecognised value to `contig`, which is the
 * same fallback `analysis/tasks/ps.ts` makes for the same reason — a stored
 * session from a later build can name a scope this one has never heard of, and
 * the honest reading is the narrowest one rather than a whole-file scan nobody
 * asked for. The two must not disagree, since one of them prices what the other
 * runs.
 */
function planUnits(
  job: JobContext,
  scope: string,
  names: readonly string[] | null,
): { units: Unit[]; missing: string[] } {
  const mc = job.mc
  /**
   * The lap of a contig the reader has declared circular, or `0`.
   *
   * Asked only where a unit is one whole sequence, because that is the only
   * shape {@link makeUnit} can answer for — see its `circular` test.
   */
  const lapOf = (cid: number, span: Span): number =>
    readsAsCircular(job, mc.chromnames[cid]) ? span.to - span.from : 0

  if (scope === 'file') {
    const spans: Span[] = []
    for (const cid of tickedContigIds(mc, null).ids) {
      const span = spanOfContig(mc, cid)
      if (span !== null) spans.push(span)
    }
    return { units: spans.length === 0 ? [] : [makeUnit('All sequences', spans)], missing: [] }
  }

  if (scope === 'genome') {
    if (!mc.hasGenomes) {
      throw new ViewerError(
        'unsupported',
        'This file is a plain cooler: it has no /genomes table, so there is nothing for a ' +
          'per-genome P(s) to be per. Use the contig scope, which is the same curve over the ' +
          'sequences this file does have.',
        { uri: mc.uri },
      )
    }
    const out: Unit[] = []
    for (const gid of mc.displayGenomes()) {
      const [c0, c1] = mc.genomeContigExtent(gid)
      const spans: Span[] = []
      for (let cid = c0; cid < c1; cid++) {
        const span = spanOfContig(mc, cid)
        if (span !== null) spans.push(span)
      }
      if (spans.length > 0) out.push(makeUnit(mc.genomeNames[gid], spans))
    }
    return { units: out, missing: [] }
  }

  // **One curve per ticked sequence, and the whole of each.** The tick boxes say
  // which sequences, never how much of one: P(s) is a property of a sequence, and
  // a curve taken from whichever window happened to be on screen but labelled
  // `chrIV` is a different quantity wearing the same name. `analysis/tasks/ps.ts`
  // prices exactly these extents, and the two agreeing is what stops a run being
  // cheaper or dearer than the button said.
  const { ids, missing } = tickedContigIds(mc, names)
  const out: Unit[] = []
  for (const cid of ids) {
    const span = spanOfContig(mc, cid)
    if (span !== null) out.push(makeUnit(mc.chromnames[cid], [span], lapOf(cid, span)))
  }
  return { units: out, missing }
}

// ---------------------------------------------------------------------------
// Reading: the block already on screen
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Reading: the streaming pass
// ---------------------------------------------------------------------------

/**
 * How many bin pairs each separation *could* have held, per unit.
 *
 * **This is the denominator, and it does not come from the pixels.** The pixel
 * table stores only the cells that are not zero, so counting the pixels a
 * separation was seen at would answer "how strong is the average contact that
 * exists at this distance" — a nearly flat curve — rather than "how likely is a
 * contact at this distance", which is the whole question. Two bins a megabase
 * apart with no read between them are evidence *for* the shape of P(s), and they
 * appear nowhere in the file. Counting them is this function.
 *
 * A span of `L` bins holds `L − k` unordered pairs at separation `k`. Under
 * `square` storage each off-diagonal pair is stored twice and both copies are
 * summed, so the count doubles with them and the mean is unchanged — the same
 * factor-of-two bookkeeping `ExpectedAccumulator.addBlock` describes for a
 * mirrored dense square, arrived at from the other side.
 *
 * With balancing on, a pair is only countable when **both** its bins survived
 * the balancer, which is no longer a closed form and costs a walk of `L` per
 * separation. That is quadratic in the length of a span and it is paid anyway:
 * dropping the filtered bins from the sum but not from the count would depress
 * P(s) by whatever fraction of the map the balancer threw away, and that
 * fraction is largest at exactly the short separations where the curve matters
 * most.
 */
function countPairs(units: Unit[], doubled: boolean, weight: Float64Array | null): Float64Array[] {
  return units.map((unit) => {
    const count = new Float64Array(unit.maxOffset + 1)
    for (const span of unit.spans) {
      const length = span.to - span.from
      const lap = unit.lap
      for (let k = 0; k <= unit.maxOffset && k < length; k++) {
        let pairs: number
        if (lap > 0) {
          // **Round the circle, every bin has a partner at every separation.**
          // A line loses one pair per bin of separation — the `L − k` above —
          // because its two ends run out; a circle has no ends, so the count is
          // flat at `L` all the way to half way round. The one exception is
          // exactly half way on an even-length sequence, where `i` and `i + L/2`
          // is the same unordered pair arrived at from both sides and there are
          // `L / 2` of them rather than `L`.
          if (weight === null) {
            pairs = 2 * k === lap ? lap / 2 : lap
          } else {
            pairs = 0
            for (let i = 0; i < length; i++) {
              const a = span.from + i
              const b = span.from + ((i + k) % lap)
              if (!Number.isNaN(weight[a]) && !Number.isNaN(weight[b])) pairs++
            }
            if (k > 0 && 2 * k === lap) pairs /= 2
          }
        } else if (weight === null) {
          pairs = length - k
        } else {
          pairs = 0
          for (let i = span.from; i + k < span.to; i++) {
            if (!Number.isNaN(weight[i]) && !Number.isNaN(weight[i + k])) pairs++
          }
        }
        count[k] += doubled && k > 0 ? pairs * 2 : pairs
      }
    }
    return count
  })
}

/** A finished curve from totals accumulated outside the accumulator class. */
function curveOf(maxOffset: number, sum: Float64Array, count: Float64Array): ExpectedCurve {
  const mean = new Float64Array(sum.length)
  for (let k = 0; k < mean.length; k++) {
    mean[k] = count[k] > 0 ? sum[k] / count[k] : Number.NaN
  }
  return { maxOffset, sum, count, mean }
}

/**
 * One pass over the pixel table, filing every cis contact by its separation.
 *
 * The bin → span map is an `Int32Array` of `nBins`, which is what makes the
 * inner loop two array reads and a comparison rather than a search: two bins
 * belong together exactly when they land in the same span, and a span never
 * crosses a contig boundary, so that one test is also the cis test.
 */
async function scanUnits(
  job: JobContext,
  units: Unit[],
  balance: boolean,
): Promise<ExpectedCurve[]> {
  const mc = job.mc
  const spanOfBin = new Int32Array(mc.nBins).fill(-1)
  const unitOfSpan: number[] = []
  // The lap of each span, so the inner loop can measure a separation the short
  // way round without a lookup per pixel. `0` on every ordinary span, which is
  // the branch the whole-file pass takes on every file that has no circular
  // sequence declared.
  const lapOfSpan: number[] = []
  for (let u = 0; u < units.length; u++) {
    for (const span of units[u].spans) {
      spanOfBin.fill(unitOfSpan.length, span.from, span.to)
      unitOfSpan.push(u)
      lapOfSpan.push(units[u].lap)
    }
  }

  const weight = validBins(mc, balance)
  job.progress(0, 1, 'counting the pairs each separation could hold')
  job.throwIfCancelled()
  const counts = countPairs(units, mc.storageMode === 'square', weight)
  const sums = units.map((unit) => new Float64Array(unit.maxOffset + 1))

  await mc.scanPixels({
    onChunk: (chunk) => {
      job.throwIfCancelled()
      for (let i = 0; i < chunk.length; i++) {
        const b1 = chunk.bin1[i]
        const b2 = chunk.bin2[i]
        const span = spanOfBin[b1]
        // Negated rather than `span < 0`, so a bin id past the end of the file —
        // which `validateDeep` exists to find and which nothing here has checked
        // — reads `undefined`, fails this test and is dropped, instead of
        // comparing equal to the other `undefined` and indexing a curve that is
        // not there.
        if (!(span >= 0) || spanOfBin[b2] !== span) continue
        const value = weight === null ? chunk.count[i] : chunk.count[i] * weight[b1] * weight[b2]
        if (Number.isNaN(value)) continue
        const straight = b2 > b1 ? b2 - b1 : b1 - b2
        const lap = lapOfSpan[span]
        const offset = lap > 0 ? Math.min(straight, lap - straight) : straight
        sums[unitOfSpan[span]][offset] += value
      }
    },
    onProgress: (done, total) => job.progress(done, total, 'reading pixels'),
  })

  return units.map((unit, u) => curveOf(unit.maxOffset, sums[u], counts[u]))
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Every unit's curve, by whichever of the three paths is cheapest and honest.
 *
 * The single-square path is only taken for a single span, and that is the whole
 * of the rule: two squares are two reads, and a rule that allowed "a few" would
 * have to say how many, on a file where the answer ranges from sixteen to a
 * hundred and fifty thousand.
 */
async function measure(
  job: JobContext,
  units: Unit[],
  balance: boolean,
  value: string,
): Promise<{ curves: ExpectedCurve[]; mirrored: boolean }> {
  // Flattened, because the shared helper asks about spans and a unit is a
  // *named group* of them — a genome-scope curve covers every contig of one MAG.
  const block = usableBlock(job, units.flatMap((unit) => unit.spans), balance)
  if (block !== null) {
    const out: ExpectedCurve[] = []
    for (let u = 0; u < units.length; u++) {
      job.throwIfCancelled()
      job.progress(u, units.length, units[u].name)
      const accumulator = new ExpectedAccumulator(units[u].maxOffset, units[u].lap)
      for (const span of units[u].spans) accumulator.addBlock(squareOf(block, span))
      out.push(accumulator.finish())
    }
    // A dense square read back from an upper-triangular store carries every
    // off-diagonal pair twice, so this path is mirrored whatever the file's
    // storage says. Invisible to a mean and not to a share of a total, which is
    // why the flag travels with the curves rather than being rederived later.
    return { curves: out, mirrored: true }
  }

  if (units.length === 1 && units[0].spans.length === 1) {
    const span = units[0].spans[0]
    job.progress(0, 1, units[0].name)
    const matrix = await job.mc.matrix({
      rows: [span.from, span.to],
      cols: [span.from, span.to],
      balance,
      value,
    })
    job.throwIfCancelled()
    const accumulator = new ExpectedAccumulator(units[0].maxOffset, units[0].lap)
    accumulator.addBlock(matrix)
    return { curves: [accumulator.finish()], mirrored: true }
  }

  if (value !== DEFAULT_COUNT_COLUMN) {
    // `scanPixels` reads `pixels/count`, so the alternative score column the map
    // is drawn from cannot reach this path. Said out loud rather than quietly
    // substituted: a curve computed from a different column than the one named
    // beside it is the kind of wrong that survives review.
    job.note(
      `The whole-file pass reads the count column, so the ${value} column this map is drawn ` +
        'from was not used. Narrow the scope to one sequence to measure that column instead.',
    )
  }
  // The pixel table, on the other hand, is mirrored only where the file itself
  // stores both triangles — the same condition `countPairs` doubles its pair
  // counts under.
  return {
    curves: await scanUnits(job, units, balance),
    mirrored: job.mc.storageMode === 'square',
  }
}

/**
 * The separations the figure opens on, in base pairs.
 *
 * A default view, not a limit: the marquee, the axis boxes and a double-click
 * all move it (`figures/FigureBlock.ts`), and the curve underneath runs from one
 * base pair to the length of the longest sequence whatever this says.
 *
 * It is here because the full extent is a bad picture of a good curve. The first
 * break holds the diagonal and the first off-diagonal — on a 1 kb map that is
 * two thirds of every cis contact in the file — at a separation of 1 bp, so a
 * log axis drawn over everything spends a third of its width on one point four
 * orders of magnitude above the rest and squashes the decades anybody reads into
 * the right-hand quarter. The other end is the mirror of it: past a megabase the
 * curve is a handful of bins with a few cells each, and it is noise drawn at the
 * same weight as the data.
 *
 * 4 kb to 1 Mb is the range a P(s) is read over on a yeast or a mammalian map
 * alike — past the ligation artefacts at the bottom and inside the shortest
 * chromosome at the top. HiContacts' own `plotPs` defaults to 5 kb–499 kb, which
 * is the same judgement made slightly tighter.
 */
const WINDOW: [number, number] = [4_000, 1_000_000]

export const runExpected: TaskRunner = async (job) => {
  const scope = strParam(job.params, 'scope', 'contig')
  const ticked = tickedSequences(job.params, 'sequences')
  const factor = numParam(job.params, 'factor', 1.1)
  const minSeparation = numParam(job.params, 'minSeparation', 0)
  // Unrecognised falls back to the density, which is what the panel has drawn
  // since the choice existed — the same rule `planUnits` follows for the scope,
  // and for the same reason: a stored session from a later build must not
  // silently change what the numbers on screen mean.
  const expectedCis = strParam(job.params, 'quantity', 'density') === 'expected'
  const derivative = boolParam(job.params, 'derivative', true)
  const balance = boolParam(job.params, 'balance', false)

  if (scope === 'contig' && ticked !== null && ticked.length === 0) {
    job.note('No sequence is ticked, so there is nothing to measure.')
    return []
  }
  const { units: planned, missing } = planUnits(job, scope, ticked)
  const said = missingSequencesNote(job.mc, missing, planned.length)
  if (said !== null) job.note(said)
  if (planned.length === 0) {
    if (said === null) {
      job.note('No sequence in this file has any bins in it, so there is nothing to measure.')
    }
    return []
  }

  // **Every sequence, and no cut.** There was a "Sequences to draw" box that
  // kept the largest N and said how many it had dropped, which turned the one
  // question this task answers — *how does contact fall with distance, on each
  // of my sequences* — into a question about a number nobody had a reason to
  // pick. A run that leaves out sequences by default is a run whose answer is
  // about a subset the reader did not choose, and the note saying so is read
  // after the figure rather than before it.
  //
  // The legend is what this used to protect, and `keepLargest` still exists for
  // it: the curves are all computed and all drawn, and only the *names* beside
  // them are capped, by the drawer that has to fit them (`analysisPlots.ts`).
  const units = planned

  const { curves, mirrored } = await measure(job, units, balance, job.framing.value)
  job.throwIfCancelled()

  const series: CurveSeries[] = []
  const slopes: CurveSeries[] = []
  let silent = 0
  for (let u = 0; u < units.length; u++) {
    const binned = expectedCis
      ? logBinCurve(curves[u], job.mc.binsize, factor, minSeparation)
      : densityCurve(curves[u], job.mc.binsize, factor, minSeparation, mirrored)
    if (binned.x.length === 0) {
      silent++
      continue
    }
    let cells = 0
    for (const n of binned.n) cells += n
    series.push({ name: units[u].name, x: binned.x, y: binned.y, n: cells })
    if (derivative) {
      const slope = logLogSlope(binned.x, binned.y)
      // Two points give no central difference at all, and a one-sided one at the
      // ends is a different estimator drawn on the same line — see `logLogSlope`.
      if (slope.x.length > 0) slopes.push({ name: units[u].name, x: slope.x, y: slope.y, n: cells })
    }
  }
  if (silent > 0) {
    job.note(
      `${silent.toLocaleString()} ${silent === 1 ? 'sequence' : 'sequences'} had no separation ` +
        'bin with any data in it at these settings, and so no line. A minimum separation longer ' +
        'than the sequence is the usual reason.',
    )
  }

  const outputs: TaskOutput[] = [
    {
      kind: 'curve',
      id: 'ps',
      label: 'Contact probability P(s)',
      series,
      xLabel: 'Genomic separation (bp)',
      yLabel: expectedCis
        ? 'Mean contact per bin pair'
        : 'Contact probability density (per bp)',
      xScale: 'log',
      yScale: 'log',
      xDomain: WINDOW,
    },
  ]
  if (slopes.length > 0) {
    outputs.push({
      kind: 'curve',
      id: 'ps-slope',
      label: 'Log-log slope of P(s)',
      series: slopes,
      xLabel: 'Genomic separation (bp)',
      yLabel: 'd log P / d log s',
      // The abscissa stays logarithmic so the panel lines up under the curve
      // above it, and the ordinate cannot: a slope is negative almost
      // everywhere, and a decaying exponent has no logarithm.
      xScale: 'log',
      yScale: 'linear',
      // The same window, so the two panels are read against one axis.
      xDomain: WINDOW,
    })
  }

  const stranded = await strandedCurves(job)
  if (stranded !== null) outputs.push(stranded)
  return outputs
}

// ---------------------------------------------------------------------------
// The four orientations, which are about records rather than about the matrix
// ---------------------------------------------------------------------------

/**
 * The orientation-resolved decay, from the import or from a named `.pairs`.
 *
 * Two sources and one figure. The **import's** curves cost nothing at all: they
 * were counted in the pass that built this map (§3.7), and they arrive on
 * `TaskInputs` because the records they came from no longer exist by the time
 * anything runs here. A **named** file is read on the spot, which is a pass over
 * somebody else's records and is priced as one in the note.
 *
 * `null` — with a sentence — wherever the reader asked for this and it cannot be
 * had. A curve silently missing from a figure the reader ticked a box for is the
 * failure mode this whole subtree is written against.
 */
async function strandedCurves(job: JobContext): Promise<TaskOutput | null> {
  if (!boolParam(job.params, 'stranded', false)) return null

  const named = strParam(job.params, 'pairsUri', '').trim()
  let counts: OrientationCounts | null = null

  if (named === '') {
    const held = job.inputs.orientation
    if (held === undefined) {
      job.note(
        'The four orientations are counted from the records, and this map has none to count: it ' +
          'was opened as a matrix rather than imported from a .pairs, or the file it was ' +
          'imported from carried no strand1/strand2 columns. Name a .pairs above, or drop one on ' +
          'the app.',
      )
      return null
    }
    counts = held
  } else {
    counts = await countNamed(job, named)
    if (counts === null) return null
  }

  const figure = orientationFigure(counts, {
    factor: Math.max(1.01, numParam(job.params, 'factor', 1.1)),
    minSeparation: job.toBp(Math.max(0, numParam(job.params, 'minSeparation', 0))),
  })
  if (figure === null) {
    job.note(
      'Fewer than two orientations have any cis record in them, so there is nothing to compare. ' +
        'A file whose strand columns are all `.` reads this way.',
    )
    return null
  }

  job.note(
    figure.convergence === null
      ? 'The four orientations never settle to within a tenth of each other, so no convergence ' +
        'point is reported. On a library that is otherwise fine this usually means the axis does ' +
        'not reach far enough — the sequences are short — rather than that the records are bad.'
      : `The four orientations converge at about ${Math.round(figure.convergence).toLocaleString()} bp, ` +
        'which is the shortest separation this library can be read at. Below it the counts are ' +
        'self-circles, dangling ends and undigested fragments rather than contacts.',
  )

  return {
    kind: 'curve',
    id: 'ps-orientation',
    label: 'P(s) by pair orientation',
    series: figure.curves.map(
      (curve): CurveSeries => ({ name: curve.name, x: curve.x, y: curve.y, n: curve.n }),
    ),
    xLabel: 'Genomic separation (bp)',
    yLabel: 'Density, over the records in all four',
    xScale: 'log',
    yScale: 'log',
  }
}

/**
 * Count the four orientations in a `.pairs` this session did not import.
 *
 * **Through `binPairs` at the coarsest possible grid**, rather than through a
 * second record loop written for this. One bin per sequence makes the binning
 * itself free — a pixel table of a few hundred entries, discarded on the way out
 * — and what the pass is actually for is the orientation accumulator it already
 * carries. A second loop would be a second place for the column resolution, the
 * clamping and the `#columns:` handling to be got right, and §3.7's record
 * reader is not a thing this application should have two of.
 */
async function countNamed(job: JobContext, uri: string): Promise<OrientationCounts | null> {
  const remote = /^(https?|s3):\/\//i.test(uri)
  // A path is a shell's whole case and a worker's impossible one, and each
  // venue says which it is by the capability it answers (`JobContext.openFile`).
  if (!remote && job.openFile === undefined) {
    job.note(
      `“${uri}” is not an address this can fetch. A local file has none — drop it on the app, ` +
        'which imports it and counts these curves in the same pass, or name it in a ' +
        '`metacooler-run` line, which reads it from disk. Only http(s) and s3 URLs can be ' +
        'named here, and a URL is fetched as it stands — a file behind a store, a share link, ' +
        'Google Drive or Dropbox is authorised by a token this box has no way to carry, so those ' +
        'are opened the usual way and imported.',
    )
    return null
  }
  const open = remote ? job.openBytes : job.openFile
  if (open === undefined) {
    job.note(
      `Reading ${uri} needs a venue that can fetch an address, and this one reads local files ` +
        'only. Fetch it first and name the file, or run it in the app.',
    )
    return null
  }
  let source
  try {
    source = await open(uri)
  } catch (error) {
    job.note(`Could not open ${uri}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  job.progress(0, 1, 'reading records')
  const header = await readPairsHeader(source)
  if (header.columns.strand1 < 0 || header.columns.strand2 < 0) {
    job.note(
      `${uri} declares no strand1/strand2 columns, so its records cannot say which orientation ` +
        'a pair was in. `pairtools` writes them by default; a file trimmed of them cannot be ' +
        'read this way.',
    )
    return null
  }

  let longest = 0
  for (const contig of header.contigs) longest = Math.max(longest, contig.length)
  const binned = await binPairs(source, {
    // One bin per sequence, which is the cheapest grid that exists and is not a
    // map: nothing reads the pixels this produces.
    binSize: Math.max(1, longest),
    contigs: header.contigs,
    columns: header.columns,
    onProgress: (done, total) => job.progress(done, total, 'reading records'),
    cancelled: () => job.cancelled(),
  })
  job.throwIfCancelled()
  if (binned === null) return null
  const orientation = binned.orientation ?? null
  if (orientation === null) {
    job.note(`${uri} carried strand columns but no cis record with a readable pair of strands.`)
    return null
  }
  return orientation
}
