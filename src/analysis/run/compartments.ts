/**
 * Compartments, run: expected → observed/expected → correlation → eigenvectors,
 * then phasing, then the saddle.
 *
 * Everything mathematical is in `analysis/compartments.ts` and
 * `analysis/linalg.ts`. What is here is the chain, the two places it can refuse,
 * and the one thing neither kernel can do for itself — building the *signal* a
 * component's sign is attached to, which means reading a gene model or a
 * FASTA's GC content over the same bins.
 *
 * The expected curve is accumulated from the very square being analysed, not
 * from the P(s) task. That is not a shortcut: an O/E over one chromosome wants
 * that chromosome's own decay, and a genome-wide curve would divide a small
 * chromosome by the average behaviour of the large ones — which shows up as a
 * spurious gradient along the eigenvector.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import type { FeatureSet } from '../../annotations/types'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { DEFAULT_DIVERGING_COLORMAP } from '../../render/colormaps'
import { parseMetacoolerRange } from '../../metacooler/range'
import {
  compartmentSegments,
  correlationMatrix,
  observedOverExpected,
  phaseComponent,
  saddle,
  usableBins,
  type Phasing,
} from '../compartments'
import { ExpectedAccumulator } from '../expected'
import {
  boolParam,
  chosenInput,
  idParam,
  numParam,
  strParam,
  type JobContext,
  type TaskRunner,
} from '../job'
import { leadingEigenpairs } from '../linalg'
import { MAX_CORRELATION_BINS } from '../tasks/compartments'
import type { MatrixOutput, ProfileOutput, TaskOutput } from '../types'
import { squareFor, usableBlock, type Span } from './blocks'

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
 * Every sequence, or the one that was named.
 *
 * Empty means **all of them**, run one after another, which is what the form's
 * *Sequence* control now defaults to. Compartments really are a property of one
 * chromosome — the correlation matrix is `m²` in that chromosome's bins and
 * pooling two of them would correlate rows that share no expected curve — so
 * "every sequence" is a loop rather than a wider read, and each pass is exactly
 * the run a reader would have configured by hand.
 *
 * A sequence past {@link MAX_CORRELATION_BINS} is **skipped with a note** rather
 * than throwing. Naming one was a refusal because the reader asked for that
 * chromosome and got nothing; meeting one in a sweep is not a reason to throw
 * away the twenty that did work.
 */
function sequencesFor(job: JobContext, region: string): number[] {
  if (region !== '') {
    const parsed = parseMetacoolerRange(job.mc, region)
    return [job.mc.coords.contigOfBin(parsed.extent[0])]
  }
  const out: number[] = []
  for (let cid = 0; cid < job.mc.chromnames.length; cid++) {
    const [from, to] = job.mc.contigExtent(cid)
    if (to > from) out.push(cid)
  }
  return out
}

export const runCompartments: TaskRunner = async (job) => {
  const region = strParam(job.params, 'region', '').trim()
  const sequences = sequencesFor(job, region)
  if (sequences.length === 0) {
    job.note('This file has no sequence with any bins in it.')
    return []
  }

  const outputs: TaskOutput[] = []
  const wanted = Math.max(1, Math.min(3, Math.round(numParam(job.params, 'components', 1))))
  // One vector per component **over the whole file**, filled in per sequence.
  // A track is a track: E1 of chromosome IV and E1 of chromosome V are the same
  // quantity on two stretches of one axis, and two rows on the Synthetic tracks
  // card saying `E1 · IV` and `E1 · V` would be a card the reader has to
  // reassemble by eye. The bins nothing wrote stay `NaN`, which is what a gap is.
  const tracks: Float32Array[] = []
  for (let i = 0; i < wanted; i++) tracks.push(new Float32Array(job.mc.nBins).fill(Number.NaN))
  const segments = new FeatureBuilder()
  let ran = 0
  let skipped = 0

  for (let s = 0; s < sequences.length; s++) {
    job.throwIfCancelled()
    const cid = sequences[s]
    const name = job.mc.chromnames[cid]
    job.progress(s, sequences.length, `Compartments on ${name}`)
    const done = await oneSequence(job, cid, wanted, tracks, segments)
    if (done === null) {
      skipped++
      continue
    }
    ran++
    if (done.saddle !== null) outputs.push(done.saddle)
  }

  if (ran === 0) {
    job.note('No sequence in this file produced a component. See the notes above for each.')
    return []
  }
  if (skipped > 0) {
    job.note(
      `${skipped.toLocaleString()} ${skipped === 1 ? 'sequence' : 'sequences'} produced no ` +
        'component and were left out of the tracks below.',
    )
  }

  // The tracks first, then the calls, then the pictures: a reader scanning the
  // drawer meets the thing they will keep before the thing they will look at.
  const label = region === '' ? '' : ` · ${job.mc.chromnames[sequences[0]]}`
  outputs.unshift(
    ...tracks.map(
      (values, i) =>
        ({
          kind: 'profile',
          id: `compartment-e${i + 1}`,
          label: `E${i + 1}${label}`,
          values,
          extent: [0, job.mc.nBins],
          binsize: job.mc.binsize,
          unit: '',
        }) satisfies ProfileOutput,
    ),
    {
      kind: 'intervals',
      id: 'compartment-ab',
      label: `A/B compartments${label}`,
      payload: { kind: 'features', data: segments.finish() },
    },
  )

  job.progress(sequences.length, sequences.length, 'Done')
  return outputs
}

/**
 * One sequence, written into the shared tracks and the shared segment list.
 *
 * `null` where this sequence produced nothing — too large, too sparse, or with
 * no leading component. Every one of those leaves a note naming the sequence,
 * because a chromosome silently missing from a genome-wide track is the failure
 * mode this loop could most easily have.
 */
async function oneSequence(
  job: JobContext,
  cid: number,
  wanted: number,
  tracks: Float32Array[],
  segments: FeatureBuilder,
): Promise<{ saddle: MatrixOutput | null } | null> {
  const [from, to] = job.mc.contigExtent(cid)
  const span: Span = { from, to }
  const name = job.mc.chromnames[cid]
  const n = to - from
  if (n > MAX_CORRELATION_BINS) {
    job.note(
      `${name} is ${n.toLocaleString()} bins, past the ${MAX_CORRELATION_BINS.toLocaleString()}-bin ` +
        'limit on a correlation matrix, so it was skipped. Open the file at a coarser resolution ' +
        'to include it.',
    )
    return null
  }

  const balance = boolParam(job.params, 'balance', true)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value

  const block = usableBlock(job, [span], balance)
  const square = await squareFor(job, span, { block, balance, value })
  job.throwIfCancelled()

  const accumulator = new ExpectedAccumulator(n)
  accumulator.addBlock({
    nrows: square.nrows,
    ncols: square.ncols,
    values: square.values,
    rowExtent: [square.rowExtent[0], square.rowExtent[1]],
    colExtent: [square.colExtent[0], square.colExtent[1]],
  })
  const curve = accumulator.finish()

  const index = usableBins(square.values, n, MIN_COVERAGE)
  if (index.length < 8) {
    job.note(
      `Only ${index.length} bins of ${name} carry enough data to correlate, which is too few ` +
        'for a component to mean anything.',
    )
    return null
  }
  if (index.length < n) {
    job.note(
      `${name}: ${(n - index.length).toLocaleString()} of ${n.toLocaleString()} bins were left ` +
        'out for want of data. They are gaps in the track rather than zeros.',
    )
  }

  const oe = observedOverExpected(square.values, n, index, curve)
  const correlation = correlationMatrix(oe, index.length)
  job.throwIfCancelled()

  // The correlation matrix is consumed in place by the deflation, so the saddle
  // below uses `oe` — which is the matrix it wants anyway.
  const pairs = leadingEigenpairs(correlation, index.length, wanted)
  if (pairs.length === 0) {
    job.note(`${name}: the correlation matrix has no leading component; it may be too sparse.`)
    return null
  }

  const signal = phasingSignal(job, name, index, from)
  let phased: Phasing | null = null

  for (let component = 0; component < pairs.length && component < tracks.length; component++) {
    const vector = pairs[component].vector
    if (signal !== null) {
      const result = phaseComponent(vector, signal, numParam(job.params, 'minR', 0.1))
      if (component === 0) {
        phased = result
        job.note(
          result.confident
            ? `${name}: E1 phased against ${result.signal} (r = ${fmt(result.r)})` +
                `${result.flipped ? ', sign flipped' : ''}.`
            : `${name}: phasing against ${result.signal} was ambiguous (r = ${fmt(result.r)}), ` +
                'so E1’s sign is arbitrary and should not be compared with another sequence.',
        )
      }
    } else if (component === 0) {
      job.note('Nothing was chosen to phase against, so the sign of each component is arbitrary.')
    }

    // Back over the full bin grid, with the excluded bins restored as gaps —
    // which is the whole reason the chain worked over an index (§18.8).
    const track = tracks[component]
    for (let i = 0; i < index.length; i++) track[from + index[i]] = vector[i]
  }

  addCompartmentSegments(job, segments, cid, index, pairs[0].vector, from)

  if (!boolParam(job.params, 'saddle', true)) return { saddle: null }
  const bins = Math.max(5, Math.min(100, Math.round(numParam(job.params, 'quantiles', 50))))
  const result = saddle(oe, index.length, pairs[0].vector, bins)
  return {
    saddle: {
      kind: 'matrix',
      id: `compartment-saddle-${cid}`,
      label: `Saddle · ${name}`,
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

/**
 * The segments {@link compartmentSegments} called, as a `FeatureSet` the
 * Annotations panel can draw and a BED can carry.
 *
 * The arithmetic is the kernel's; what is here is the coordinate conversion —
 * bins to base pairs, clamped at the sequence's own end so the last segment
 * stops where the chromosome does rather than at the end of a bin that runs past
 * it.
 */
function addCompartmentSegments(
  job: JobContext,
  builder: FeatureBuilder,
  cid: number,
  index: Int32Array,
  vector: Float64Array,
  offset: number,
): void {
  const name = job.mc.chromnames[cid]
  const binsize = job.mc.binsize
  const length = job.mc.chromsizes.get(name) ?? Number.POSITIVE_INFINITY
  // The kernel works in the index's own numbering, which starts at the
  // sequence's first bin; the file's is absolute.
  const local = Int32Array.from(index, (bin) => bin + offset)
  for (const segment of compartmentSegments(local, vector)) {
    const from = (segment.from - offset) * binsize
    const to = Math.min(length, (segment.to - offset + 1) * binsize)
    builder.add(name, from, to, {
      name: segment.side,
      score: segment.mean,
      detail: `E1 mean ${segment.mean.toFixed(3)} · ${segment.bins} bins`,
    })
  }
}

function fmt(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '—'
}

/**
 * The signal a component's sign is attached to, over the usable bins.
 *
 * A gene model first, because gene density is the conventional phasing signal
 * and the one a reader will recognise; a FASTA's GC content second, because it
 * is the fallback every tool offers and it needs no annotation at all. Both are
 * over this sequence and nothing else.
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
  contig: string,
  index: Int32Array,
  offset: number,
): { name: string; values: Float64Array } | null {
  // By the **parameter key**, `phaseFeatures`, exactly as the GC vector below is
  // read under `phaseSequence` — see `chosenInput`.
  const set = chosenInput(job.inputs.features, job.params, 'phaseFeatures').value
  if (set !== undefined) {
    return { name: 'gene density', values: densityOf(job, set, contig, index, offset) }
  }

  const sequenceId = idParam(job.params, 'phaseSequence')
  if (sequenceId === null) return null
  const gc = job.inputs.vectors?.['phaseSequence']
  if (gc === undefined) {
    // The row was dropped between the form being filled in and Run being
    // pressed, or the file has no sequence for this contig. Named rather than
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
    const bin = offset + index[i]
    out[i] = bin >= 0 && bin < gc.length ? gc[bin] : Number.NaN
  }
  return { name: 'GC content', values: out }
}

/** Features per bin, over one sequence, in the order the index gives. */
function densityOf(
  job: JobContext,
  set: FeatureSet,
  contig: string,
  index: Int32Array,
  offset: number,
): Float64Array {
  const cid = set.contigs.indexOf(contig)
  const perBin = new Float64Array(job.mc.nBins)
  if (cid >= 0) {
    const mapId = job.mc.contigId(contig)
    for (let i = 0; i < set.length; i++) {
      if (set.contig[i] !== cid) continue
      // Every bin the feature covers, not only the one it starts in: a gene
      // spanning ten bins is evidence about ten bins, and counting only its
      // start would make density a picture of where genes begin.
      const first = job.mc.coords.binIndex(mapId, set.start[i])
      const last = job.mc.coords.binIndex(mapId, Math.max(set.start[i], set.end[i] - 1))
      for (let bin = first; bin <= last; bin++) {
        if (bin >= 0 && bin < perBin.length) perBin[bin] += 1
      }
    }
  }
  const out = new Float64Array(index.length)
  for (let i = 0; i < index.length; i++) out[i] = perBin[offset + index[i]]
  return out
}
