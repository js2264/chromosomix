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

import type { FeatureSet } from '../../annotations/types'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { DEFAULT_DIVERGING_COLORMAP } from '../../render/colormaps'
import { parseMetacoolerRange } from '../../metacooler/range'
import {
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

export const runCompartments: TaskRunner = async (job) => {
  const region = strParam(job.params, 'region', '').trim()
  if (region === '') {
    // Compartments are a property of one chromosome, so unlike insulation this
    // task has no whole-file reading to fall back on.
    job.note('No sequence was chosen. Pick the chromosome to call compartments on.')
    return []
  }
  const parsed = parseMetacoolerRange(job.mc, region)
  const cid = job.mc.coords.contigOfBin(parsed.extent[0])
  const [from, to] = job.mc.contigExtent(cid)
  const span: Span = { from, to }
  const name = job.mc.chromnames[cid]
  const n = to - from
  if (n > MAX_CORRELATION_BINS) {
    throw new Error(
      `Refusing to build a ${n.toLocaleString()}×${n.toLocaleString()} correlation matrix for ` +
        `${name}. The limit is ${MAX_CORRELATION_BINS.toLocaleString()} bins a side.`,
    )
  }

  const balance = boolParam(job.params, 'balance', true)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value

  job.progress(0, 4, `Reading ${name}`)
  const block = usableBlock(job, [span], balance)
  const square = await squareFor(job, span, { block, balance, value })
  job.throwIfCancelled()

  job.progress(1, 4, 'Expected')
  const accumulator = new ExpectedAccumulator(n)
  accumulator.addBlock({
    nrows: square.nrows,
    ncols: square.ncols,
    values: square.values,
    rowExtent: [square.rowExtent[0], square.rowExtent[1]],
    colExtent: [square.colExtent[0], square.colExtent[1]],
  })
  const curve = accumulator.finish()

  const index = usableBins(square.values, n, numParam(job.params, 'minCoverage', 0.1))
  if (index.length < 8) {
    job.note(
      `Only ${index.length} bins of ${name} carry enough data to correlate, which is too few ` +
        'for a component to mean anything.',
    )
    return []
  }
  if (index.length < n) {
    job.note(
      `${(n - index.length).toLocaleString()} of ${n.toLocaleString()} bins were left out for ` +
        'want of data. They are gaps in the track rather than zeros.',
    )
  }

  job.progress(2, 4, 'Correlation')
  const oe = observedOverExpected(square.values, n, index, curve)
  const correlation = correlationMatrix(oe, index.length)
  job.throwIfCancelled()

  job.progress(3, 4, 'Eigenvectors')
  const wanted = Math.max(1, Math.min(3, Math.round(numParam(job.params, 'components', 1))))
  // The correlation matrix is consumed in place by the deflation, so the saddle
  // below uses `oe` — which is the matrix it wants anyway.
  const pairs = leadingEigenpairs(correlation, index.length, wanted)
  if (pairs.length === 0) {
    job.note('The correlation matrix has no leading component; the sequence may be too sparse.')
    return []
  }

  const signal = phasingSignal(job, name, index, from)
  const outputs: TaskOutput[] = []
  let phased: Phasing | null = null

  for (let component = 0; component < pairs.length; component++) {
    const vector = pairs[component].vector
    if (signal !== null) {
      const result = phaseComponent(vector, signal, numParam(job.params, 'minR', 0.1))
      if (component === 0) phased = result
      if (component === 0 && !result.confident) {
        job.note(
          `Phasing against ${result.signal} was ambiguous (r = ${fmt(result.r)}), so E1's sign ` +
            'is arbitrary and should not be compared with another sequence.',
        )
      } else if (component === 0) {
        job.note(
          `E1 phased against ${result.signal} (r = ${fmt(result.r)})` +
            `${result.flipped ? ', sign flipped' : ''}.`,
        )
      }
    } else if (component === 0) {
      job.note('Nothing was chosen to phase against, so the sign of each component is arbitrary.')
    }

    // Back over the full bin grid, with the excluded bins restored as gaps —
    // which is the whole reason the chain worked over an index (§18.8).
    const values = new Float32Array(job.mc.nBins).fill(Number.NaN)
    for (let i = 0; i < index.length; i++) values[from + index[i]] = vector[i]
    outputs.push({
      kind: 'profile',
      id: `compartment-e${component + 1}`,
      label: `E${component + 1} · ${name}`,
      values,
      extent: [0, job.mc.nBins],
      binsize: job.mc.binsize,
      unit: '',
    } satisfies ProfileOutput)
  }

  if (boolParam(job.params, 'saddle', true)) {
    const bins = Math.max(5, Math.min(100, Math.round(numParam(job.params, 'quantiles', 50))))
    const result = saddle(oe, index.length, pairs[0].vector, bins)
    outputs.push({
      kind: 'matrix',
      id: 'compartment-saddle',
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
    } satisfies MatrixOutput)
  }

  job.progress(4, 4, 'Done')
  return outputs
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
