/**
 * Domains, run — the composite in full.
 *
 * The insulation half arrives as an upstream result: the runner has already run
 * that task, with its own parameters, and handed the boundaries over in
 * `inputs.upstream`. What is left is the part that makes this a task rather than
 * a second way of pressing the insulation button — turning consecutive
 * boundaries into *domains*, and then piling the map up at the calls so the set
 * can be judged.
 *
 * **Two boundaries make a domain; one makes nothing.** A sequence with a single
 * called boundary has no interior to report, and inventing one that runs to the
 * end of the chromosome would assert a domain edge the data never placed. So the
 * domains of a sequence are the gaps *between* its calls, and the two ends of the
 * sequence are left out.
 *
 * **The pileup is stratified by strength, because that is the check.** One
 * aggregate over every call says only that the average call looks like
 * something. Splitting them by the prominence they were called on and drawing
 * one pileup per group is what distinguishes a set with real boundaries at the
 * top and noise at the bottom from a set that is noise throughout — and the two
 * are indistinguishable from a single picture.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { PileupAccumulator, p2ll } from '../apa'
import { boolParam, numParam, type JobContext, type TaskRunner } from '../job'
import type { IntervalsOutput, MatrixOutput, TableOutput, TaskOutput } from '../types'
import { squareFor, usableBlock, type Span } from './blocks'

/** A called boundary, back out of the upstream task's interval output. */
interface Call {
  contig: string
  /** Bin of the call, absolute. */
  bin: number
  prominence: number
}

/** One domain: the span between two consecutive calls on one sequence. */
interface Domain {
  contig: string
  start: number
  end: number
  /** The weaker of the two boundaries that bound it. */
  strength: number
}

export const runCid: TaskRunner = async (job) => {
  const upstream = job.inputs.upstream?.insulation
  if (upstream === undefined) {
    throw new Error('The insulation step produced no result, so there is nothing to call domains from.')
  }
  const intervals = upstream.outputs.find(
    (output): output is IntervalsOutput => output.kind === 'intervals',
  )
  if (intervals === undefined || intervals.payload.kind !== 'features') {
    job.note('Insulation called no boundaries at this prominence, so there are no domains.')
    return []
  }

  const set = intervals.payload.data
  const calls: Call[] = []
  for (let i = 0; i < set.length; i++) {
    const contig = set.contigs[set.contig[i]]
    if (!job.mc.hasContig(contig)) continue
    const cid = job.mc.contigId(contig)
    calls.push({
      contig,
      bin: job.mc.coords.binIndex(cid, set.start[i]),
      prominence: set.score[i],
    })
  }
  if (calls.length < 2) {
    job.note('Fewer than two boundaries were called, so no domain has both of its edges.')
    return []
  }

  const minSize = Math.max(1, job.toBins(numParam(job.params, 'minSize', 20_000)))
  const domains = domainsOf(calls, minSize, job.mc.binsize)
  if (domains.length === 0) {
    job.note(`Every pair of boundaries was closer together than the smallest domain allowed.`)
    return []
  }

  const outputs: TaskOutput[] = [domainOutput(domains), domainTable(domains)]
  job.note(
    `${domains.length.toLocaleString()} domains between ${calls.length.toLocaleString()} boundaries.`,
  )

  if (boolParam(job.params, 'aggregate', true)) {
    outputs.push(...(await aggregateCalls(job, calls)))
  }
  return outputs
}

/**
 * Consecutive calls on one sequence, paired into domains.
 *
 * Sorted per contig rather than globally, because "consecutive" is a property of
 * a sequence: the last call on `chrIV` and the first on `chrV` are adjacent in a
 * sorted list and are not two ends of anything.
 */
function domainsOf(calls: Call[], minSizeBins: number, binsize: number): Domain[] {
  const byContig = new Map<string, Call[]>()
  for (const call of calls) {
    const held = byContig.get(call.contig)
    if (held === undefined) byContig.set(call.contig, [call])
    else held.push(call)
  }
  const out: Domain[] = []
  for (const [contig, group] of byContig) {
    group.sort((a, b) => a.bin - b.bin)
    for (let i = 1; i < group.length; i++) {
      const from = group[i - 1]
      const to = group[i]
      if (to.bin - from.bin < minSizeBins) continue
      out.push({
        contig,
        start: from.bin * binsize,
        end: to.bin * binsize,
        // The weaker edge, because a domain is only as well-defined as its
        // worse-supported side — reporting the stronger would let one good
        // boundary vouch for a run of bad ones.
        strength: Math.min(from.prominence, to.prominence),
      })
    }
  }
  return out
}

function domainOutput(domains: Domain[]): IntervalsOutput {
  const builder = new FeatureBuilder()
  for (const domain of domains) {
    builder.add(domain.contig, domain.start, domain.end, {
      score: domain.strength,
      detail: `weaker boundary prominence ${domain.strength.toFixed(3)}`,
    })
  }
  return {
    kind: 'intervals',
    id: 'cid-domains',
    label: 'Domains',
    payload: { kind: 'features', data: builder.finish() },
  }
}

function domainTable(domains: Domain[]): TableOutput {
  const sorted = [...domains].sort((a, b) => b.strength - a.strength)
  return {
    kind: 'table',
    id: 'cid-table',
    label: 'Domains',
    columns: [
      { key: 'contig', label: 'Sequence', kind: 'text' },
      { key: 'start', label: 'Start', kind: 'number', digits: 0 },
      { key: 'end', label: 'End', kind: 'number', digits: 0 },
      { key: 'size', label: 'Size (bp)', kind: 'number', digits: 0 },
      { key: 'strength', label: 'Weaker edge', kind: 'number', digits: 3 },
    ],
    rows: sorted.map((domain) => ({
      contig: domain.contig,
      start: domain.start,
      end: domain.end,
      size: domain.end - domain.start,
      strength: domain.strength,
    })),
  }
}

/**
 * The pileup at the calls, in strength groups.
 *
 * On-diagonal and centred on each boundary, which is what makes the picture
 * readable: a real boundary shows as a *corner* — two domains meeting, with the
 * cross-quadrants dark — and the eye reads that immediately where it cannot read
 * a number.
 */
async function aggregateCalls(job: JobContext, calls: Call[]): Promise<TaskOutput[]> {
  const half = Math.max(5, Math.round(numParam(job.params, 'apaWindow', 20)))
  const side = half * 2 + 1
  const strata = Math.max(1, Math.min(4, Math.round(numParam(job.params, 'strata', 2))))
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value

  const sorted = [...calls].sort((a, b) => b.prominence - a.prominence)
  const size = Math.ceil(sorted.length / strata)
  const groups: Call[][] = []
  for (let g = 0; g < strata; g++) {
    const slice = sorted.slice(g * size, (g + 1) * size)
    if (slice.length > 0) groups.push(slice)
  }

  const spans: Span[] = []
  for (const call of calls) {
    const cid = job.mc.contigId(call.contig)
    const [from, to] = job.mc.contigExtent(cid)
    if (call.bin - half >= from && call.bin + half + 1 <= to) {
      spans.push({ from: call.bin - half, to: call.bin + half + 1 })
    }
  }
  const block = usableBlock(job, spans, balance)

  const outputs: TaskOutput[] = []
  let done = 0
  const total = groups.reduce((sum, group) => sum + group.length, 0)

  for (let g = 0; g < groups.length; g++) {
    const pileup = new PileupAccumulator(side, side)
    for (const call of groups[g]) {
      job.throwIfCancelled()
      job.progress(done++, total, `Aggregating group ${g + 1}`)
      const cid = job.mc.contigId(call.contig)
      const [from, to] = job.mc.contigExtent(cid)
      const span = { from: call.bin - half, to: call.bin + half + 1 }
      // Clipped windows are dropped, not padded: a pileup is an average over
      // identically shaped things, and half a window in the middle of the
      // picture is signal in the wrong cells.
      if (span.from < from || span.to > to) continue
      const square = await squareFor(job, span, { block, balance, value })
      pileup.add(square.values)
    }
    const { values, n } = pileup.finish()
    if (n === 0) continue
    outputs.push({
      kind: 'matrix',
      id: `cid-pileup-${g}`,
      label:
        groups.length === 1
          ? 'Boundaries, aggregated'
          : `Boundaries, aggregated · group ${g + 1} of ${groups.length}`,
      nrows: side,
      ncols: side,
      values,
      xLabel: 'Bins from the boundary',
      yLabel: 'Bins from the boundary',
      xTicks: [],
      yTicks: [],
      colormap: 'default',
      stats: [
        { label: 'boundaries', value: n, digits: 0 },
        {
          label: 'corner',
          value: p2ll(values, side, side),
          digits: 2,
          hint: 'Below 1 is what a boundary looks like: the centre is emptier than its corner.',
        },
      ],
    } satisfies MatrixOutput)
  }
  job.progress(total, total, 'Done')
  return outputs
}
