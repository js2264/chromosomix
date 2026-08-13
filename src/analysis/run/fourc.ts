/**
 * The 4C task, run.
 *
 * Two paths, and the difference between them is the whole design of the task
 * (`analysis/tasks/fourc.ts`) — on a cooler. **A metagenome always takes the
 * second**, whatever the parameters say, because the contacts a MAG makes with
 * the rest of the community are the reading such a file exists for and the cis
 * half alone is one assembly pretending it was sequenced on its own.
 *
 * The cis path shares `bandSums` with
 * `render/viewpoint.ts` — the *same function* the lane on the map uses, imported
 * rather than reimplemented, so the exported bigWig and the strip above the
 * picture cannot disagree about what a band sum is. The trans path cannot: there
 * is no dense block over a whole metagenome to take a band out of, so it walks
 * the pixels.
 *
 * **The walk stops early, and that is the point.** Pixels are ordered by
 * `bin1`, and every pixel this profile needs has `bin1 < anchorEnd` — either
 * because `bin1` is inside the anchor, or because `bin1` is before it and `bin2`
 * lands in it. Past that point nothing can contribute, so `onChunk` returns
 * `false` and the read ends there: on average half the file rather than all of
 * it, which is exactly what §18.6 prices.
 */


import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { parseMetacoolerRange } from '../../metacooler/range'
import { ExpectedAccumulator, expectedAt } from '../expected'
import { boolParam, strParam, type JobContext, type TaskRunner } from '../job'
import type { ProfileOutput, TaskOutput } from '../types'
import { bandSums, ViewpointAccumulator } from '../viewpoint'
import type { BlockInput } from '../worker/protocol'
import { squareFor, usableBlock, validBins, type Span } from './blocks'

/** The anchor, resolved to absolute bins, and the scope "cis" means for it. */
interface Anchor {
  band: Span
  /** The sequence — or the whole MAG — a cis-only run stays inside. */
  scope: Span
  label: string
}

/**
 * The anchor, and what *cis* means around it.
 *
 * A locus names a contig, so cis is that contig. A **genome** may also be named,
 * and then cis is the whole MAG rather than whichever of its contigs the first
 * bin happens to fall in — on a metagenome the second reading would silently
 * answer a question about one contig of an organism when the reader asked about
 * the organism, which is the distinction §3.2 exists to make.
 */
function resolveAnchor(job: JobContext, text: string): Anchor {
  const mc = job.mc
  const parsed = parseMetacoolerRange(mc, text)
  const band: Span = {
    from: parsed.extent[0],
    to: Math.max(parsed.extent[0] + 1, parsed.extent[1]),
  }
  if (parsed.kind === 'genome') {
    const [from, to] = mc.genomeExtent(parsed.label)
    return { band, scope: { from, to }, label: parsed.label }
  }
  const cid = mc.coords.contigOfBin(band.from)
  const [from, to] = mc.contigExtent(cid)
  return { band, scope: { from, to }, label: mc.chromnames[cid] }
}

export const runFourC: TaskRunner = async (job) => {
  const text = strParam(job.params, 'anchor', '').trim()
  if (text === '') {
    job.note(
      'No anchor was chosen. Type a locus — `chrIV:500,000-510,000`, or a whole sequence by ' +
        'name — or press “Pick on map” and drag along either axis.',
    )
    return []
  }
  const balance = boolParam(job.params, 'balance', false)
  // **A metagenome is read whole, and raw.** Neither key is offered on such a
  // file (`tasks/fourc.ts`) and neither is trusted here: a stored session, a
  // form filled in on a cooler and a default all leave `cis` sitting at `true`,
  // and honouring it would give back the profile a reader has just told us is
  // the wrong one — one MAG against itself, with the rest of the community, the
  // thing the map is *of*, left as gaps. `normalise` goes the same way: the
  // decay of one assembly's contigs is not the expectation for contact between
  // assemblies, so the ratio would carry two meanings in one track.
  const whole = job.mc.hasGenomes
  const cis = !whole && boolParam(job.params, 'cis', true)
  const overExpected = !whole && strParam(job.params, 'normalise', 'none') === 'ps'
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const anchor = resolveAnchor(job, text)

  const values = cis
    ? await cisProfile(job, anchor, balance, value, overExpected)
    : await wholeProfile(job, anchor, balance, overExpected)

  const profile: ProfileOutput = {
    kind: 'profile',
    id: `fourc-${anchor.band.from}-${anchor.band.to}`,
    // The suffix marks a *choice*, so a metagenome — where every 4C is over the
    // whole file — does not carry it. There it would name the only thing the
    // task does, on every track, which is a label that distinguishes nothing.
    label: `4C · ${text}${cis || whole ? '' : ' (with trans)'}${overExpected ? ' · O/E' : ''}`,
    values,
    extent: [0, job.mc.nBins],
    binsize: job.mc.binsize,
    // A ratio has no unit, and calling one "contacts" would put a number
    // centred on 1 under an axis labelled as a count.
    unit: overExpected ? '' : 'contacts',
  }
  const outputs: TaskOutput[] = [profile]
  return outputs
}

/**
 * The whole file, with both halves of the profile against their own expectation.
 *
 * Without normalisation this is the pixel walk and nothing else. With it, the
 * two halves have two different expectations and **both** have to be applied, or
 * the track holds raw counts on the anchor's own sequence and ratios everywhere
 * else — one quantity by the axis, two quantities by the arithmetic, and no
 * mark on the picture to say which bin is which. That is what this used to do:
 * `overTransMean` skipped the cis half on the stated grounds that the decay had
 * already been divided out of it, which was true on the cis-only path and never
 * on this one, where nothing had read a square at all.
 *
 * So the square gets read. It is one on-diagonal block for one sequence against
 * a pass that is already touching half the pixels in the file, and it is only
 * read when a reader has asked for the ratio.
 */
async function wholeProfile(
  job: JobContext,
  anchor: Anchor,
  balance: boolean,
  overExpected: boolean,
): Promise<Float32Array> {
  // Before the walk rather than after it, so the progress line runs forwards:
  // `transProfile` reports its way through the file and this would otherwise
  // send it back to the start once the reader had watched it finish.
  // `DEFAULT_COUNT_COLUMN` and not `value`: {@link transProfile} walks the
  // pixels' `count` whatever the map is drawn from, and says so. A cis half read
  // from another column would put the two quantities back in one track by a
  // second route — the one this function exists to close.
  const scored = overExpected
    ? await cisProfile(job, anchor, balance, DEFAULT_COUNT_COLUMN, true)
    : null
  const read = await transProfile(job, anchor, balance)
  if (scored === null) return read
  const out = overTransMean(job, read, anchor)
  // The anchor's own sequence, over its own decay; everything else over the
  // trans mean {@link overTransMean} just applied.
  for (let bin = anchor.scope.from; bin < Math.min(anchor.scope.to, out.length); bin++) {
    out[bin] = scored[bin]
  }
  return out
}

/**
 * A profile divided by the decay, cell by cell.
 *
 * The curve is accumulated from **the square this task has already read**, which
 * is the anchor's own sequence — not the P(s) task's genome-wide one. A small
 * chromosome divided by the average behaviour of the large ones comes out with a
 * slope that is a property of the set rather than of this locus, and the slope
 * is exactly what a reader turns this on to remove.
 *
 * A bin whose expectation is unknown becomes a gap rather than keeping its
 * numerator: half of a ratio is not a ratio, and a track holding both raw counts
 * and O/E values would be read as one quantity.
 */
function overDecay(sums: Float64Array, square: BlockInput, band: [number, number]): Float64Array {
  // `addBlock` rather than a loop written here: it files each cell under the
  // separation its *absolute* bins imply and counts a mirrored square exactly
  // once per stored copy, which are the two things a second implementation of
  // this gets wrong. It is also the one that cannot read a rectangular block
  // down the wrong stride.
  const accumulator = new ExpectedAccumulator(Math.max(0, square.nrows - 1))
  accumulator.addBlock({
    nrows: square.nrows,
    ncols: square.ncols,
    values: square.values,
    rowExtent: [square.rowExtent[0], square.rowExtent[1]],
    colExtent: [square.colExtent[0], square.colExtent[1]],
  })
  const curve = accumulator.finish()
  // The anchor's own middle is where every separation is measured from. A band
  // is usually a bin or two wide, so its centre is the honest single point.
  const centre = (band[0] + band[1] - 1) / 2
  const out = new Float64Array(sums.length)
  for (let i = 0; i < sums.length; i++) {
    const expected = expectedAt(curve, Math.abs(i - centre))
    out[i] =
      Number.isFinite(sums[i]) && Number.isFinite(expected) && expected !== 0
        ? sums[i] / expected
        : Number.NaN
  }
  return out
}

/**
 * The trans half of a profile, over its own mean.
 *
 * Two chromosomes have no separation between them, so there is no curve to read
 * and the expectation is the mean of what this anchor reaches off its own
 * sequence — the same rule the compartment chain applies to a trans block. The
 * cis half is left exactly as it came in, because {@link wholeProfile} overwrites
 * it with the decay-normalised one; both halves then come out as ratios against
 * their own expectation and can be read on one axis.
 */
function overTransMean(job: JobContext, values: Float32Array, anchor: Anchor): Float32Array {
  let total = 0
  let seen = 0
  for (let bin = 0; bin < values.length; bin++) {
    if (bin >= anchor.scope.from && bin < anchor.scope.to) continue
    const value = values[bin]
    if (!Number.isFinite(value)) continue
    total += value
    seen++
  }
  if (seen === 0) {
    job.note('Nothing was reached outside this sequence, so there is no trans expectation to divide by.')
    return values
  }
  const mean = total / seen
  const out = new Float32Array(values.length)
  for (let bin = 0; bin < values.length; bin++) {
    // Only what is outside the anchor's own sequence: the cis half is replaced
    // wholesale by {@link wholeProfile} with its decay-normalised counterpart.
    const inside = bin >= anchor.scope.from && bin < anchor.scope.to
    const value = values[bin]
    out[bin] = inside || !Number.isFinite(value) ? value : mean === 0 ? Number.NaN : value / mean
  }
  return out
}

/**
 * The anchor's own sequence, from one square.
 *
 * `bandSums` takes the anchor as **block-local** indices on the axis the band is
 * taken over, which is what the lane hands it too; converting once here is what
 * keeps that function free of any idea where the block came from.
 */
async function cisProfile(
  job: JobContext,
  anchor: Anchor,
  balance: boolean,
  value: string,
  overExpected = false,
): Promise<Float32Array> {
  job.progress(0, 1, `Reading ${anchor.label}`)
  // The view's block only where it holds the column being asked for.
  // `usableBlock` vouches for the resolution and the balancing and not for the
  // value column — it is whatever the map happens to be drawn from — so a caller
  // that wants `count` off a map drawn from `expected` has to read.
  const framed = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const block = value === framed ? usableBlock(job, [anchor.scope], balance) : null
  const square = await squareFor(job, anchor.scope, { block, balance, value })
  job.throwIfCancelled()

  const local: [number, number] = [
    Math.max(0, anchor.band.from - anchor.scope.from),
    Math.min(anchor.scope.to - anchor.scope.from, anchor.band.to - anchor.scope.from),
  ]
  const sums = bandSums(
    {
      nrows: square.nrows,
      ncols: square.ncols,
      values: square.values,
      rowExtent: [square.rowExtent[0], square.rowExtent[1]],
      colExtent: [square.colExtent[0], square.colExtent[1]],
    },
    local,
    'cols',
  )

  const scored = overExpected ? overDecay(sums, square, local) : sums

  // Over the whole assembly, with everything outside this sequence left as a
  // gap. Not zero: a cis-only run has said nothing at all about the other
  // sequences, and a track claiming zero contact there would be a claim it did
  // not make.
  const out = new Float32Array(job.mc.nBins).fill(Number.NaN)
  for (let i = 0; i < scored.length; i++) out[anchor.scope.from + i] = scored[i]
  return out
}

/**
 * Every contact the anchor makes, wherever it lands.
 *
 * One accumulator over every bin in the file, fed from a partial pass. A pixel
 * contributes when either of its ends is inside the anchor, and the *other* end
 * is the bin that receives it — which for a pixel with both ends inside the
 * anchor means it contributes to both, exactly as the dense band sum would count
 * it twice on a mirrored square.
 */
async function transProfile(
  job: JobContext,
  anchor: Anchor,
  balance: boolean,
): Promise<Float32Array> {
  const mc = job.mc
  const weights = validBins(mc, balance)
  if (job.framing.value !== '' && job.framing.value !== DEFAULT_COUNT_COLUMN) {
    job.note(
      `The map is drawn from the ${job.framing.value} column, but a whole-file pass reads ` +
        `${DEFAULT_COUNT_COLUMN}. This profile is of the counts.`,
    )
  }

  const accumulator = new ViewpointAccumulator(mc.nBins, anchor.band)
  let stopped = false

  await mc.scanPixels({
    onChunk: (chunk) => {
      job.throwIfCancelled()
      for (let i = 0; i < chunk.length; i++) {
        const bin1 = chunk.bin1[i]
        if (!accumulator.reachable(bin1)) {
          stopped = true
          return false
        }
        const bin2 = chunk.bin2[i]
        const raw = chunk.count[i]
        accumulator.add(bin1, bin2, weights === null ? raw : raw * weights[bin1] * weights[bin2])
      }
      return true
    },
    onProgress: (done, total) => {
      if (!stopped) job.progress(done, total, 'Reading pixels')
    },
  })
  job.throwIfCancelled()
  job.progress(1, 1, 'Done')

  return accumulator.finish(weights === null ? null : (bin) => Number.isFinite(weights[bin]))
}
