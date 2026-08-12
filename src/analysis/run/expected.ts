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
import type { MetaCooler } from '../../metacooler/MetaCooler'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseRegionString } from '../../metacooler/range'
import {
  ExpectedAccumulator,
  logBinCurve,
  logLogSlope,
  type ExpectedCurve,
} from '../expected'
import {
  boolParam,
  contigIdFor,
  numParam,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import {
  displayableContigs,
  spanOfContig,
  squareOf,
  usableBlock,
  validBins,
  type Span,
} from './blocks'
import type { CurveSeries, TaskOutput } from '../types'

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
}

function makeUnit(name: string, spans: Span[]): Unit {
  let bins = 0
  let longest = 0
  for (const span of spans) {
    const length = span.to - span.from
    bins += length
    if (length > longest) longest = length
  }
  return { name, spans, bins, maxOffset: Math.max(0, longest - 1) }
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
function planUnits(mc: MetaCooler, scope: string, region: string): Unit[] {
  if (scope === 'file') {
    const spans: Span[] = []
    for (const cid of displayableContigs(mc)) {
      const span = spanOfContig(mc, cid)
      if (span !== null) spans.push(span)
    }
    return spans.length === 0 ? [] : [makeUnit('All sequences', spans)]
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
    return out
  }

  if (region !== '') {
    // The *sequence* the region names, and the whole of it. Sub-coordinates say
    // which contig is meant, never how much of it is read: P(s) is a property of
    // a sequence, and a curve taken from whichever window happened to be on
    // screen but labelled `chrIV` is a different quantity wearing the same name.
    // `analysis/tasks/ps.ts` prices exactly this extent, and the two agreeing is
    // what stops a run being cheaper or dearer than the button said.
    //
    // Resolved through {@link contigIdFor} rather than by string, because the
    // name is the reader's and a batch asks it of every panel of a deck (§18.2):
    // a `.hic` writing `1` beside a `.cool` writing `chr1` met `unknown-label`
    // and reported a failure about a file that has the sequence (§5.9).
    const cid = contigIdFor(mc, parseRegionString(region)[0])
    const span = cid < 0 ? null : spanOfContig(mc, cid)
    return span === null ? [] : [makeUnit(mc.chromnames[cid], [span])]
  }

  const out: Unit[] = []
  for (const cid of displayableContigs(mc)) {
    const span = spanOfContig(mc, cid)
    if (span !== null) out.push(makeUnit(mc.chromnames[cid], [span]))
  }
  return out
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
      for (let k = 0; k < length; k++) {
        let pairs = length - k
        if (weight !== null) {
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
  for (let u = 0; u < units.length; u++) {
    for (const span of units[u].spans) {
      spanOfBin.fill(unitOfSpan.length, span.from, span.to)
      unitOfSpan.push(u)
    }
  }

  const weight = validBins(mc, balance)
  job.progress(0, 1, 'Counting the pairs each separation could hold')
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
        sums[unitOfSpan[span]][b2 > b1 ? b2 - b1 : b1 - b2] += value
      }
    },
    onProgress: (done, total) => job.progress(done, total, 'Reading pixels'),
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
): Promise<ExpectedCurve[]> {
  // Flattened, because the shared helper asks about spans and a unit is a
  // *named group* of them — a genome-scope curve covers every contig of one MAG.
  const block = usableBlock(job, units.flatMap((unit) => unit.spans), balance)
  if (block !== null) {
    const out: ExpectedCurve[] = []
    for (let u = 0; u < units.length; u++) {
      job.throwIfCancelled()
      job.progress(u, units.length, units[u].name)
      const accumulator = new ExpectedAccumulator(units[u].maxOffset)
      for (const span of units[u].spans) accumulator.addBlock(squareOf(block, span))
      out.push(accumulator.finish())
    }
    return out
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
    const accumulator = new ExpectedAccumulator(units[0].maxOffset)
    accumulator.addBlock(matrix)
    return [accumulator.finish()]
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
  return scanUnits(job, units, balance)
}

export const runExpected: TaskRunner = async (job) => {
  const scope = strParam(job.params, 'scope', 'contig')
  const region = strParam(job.params, 'region', '').trim()
  const factor = numParam(job.params, 'factor', 1.1)
  const minSeparation = numParam(job.params, 'minSeparation', 0)
  const derivative = boolParam(job.params, 'derivative', true)
  const balance = boolParam(job.params, 'balance', false)

  const planned = planUnits(job.mc, scope, region)
  if (planned.length === 0) {
    job.note('No sequence in this file has any bins in it, so there is nothing to measure.')
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

  const curves = await measure(job, units, balance, job.framing.value)
  job.throwIfCancelled()

  const series: CurveSeries[] = []
  const slopes: CurveSeries[] = []
  let silent = 0
  for (let u = 0; u < units.length; u++) {
    const binned = logBinCurve(curves[u], job.mc.binsize, factor, minSeparation)
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
      yLabel: 'Contact probability',
      xScale: 'log',
      yScale: 'log',
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
    })
  }
  return outputs
}
