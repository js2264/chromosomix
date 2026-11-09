/**
 * TAD annotation, run: Arrowhead over each ticked sequence.
 *
 * `analysis/arrowhead.ts` is the method and does not know where a square comes
 * from; this file hands it each window Juicer would read — out of the block on
 * screen where that block can answer for it, from the file where it cannot —
 * and turns what comes back into the two things a domain call leaves as: a set
 * drawn as corners on the map, and Juicer's own BEDPE columns as a table.
 */

import { FeatureBuilder } from '../../annotations/featureset'
import { DEFAULT_COUNT_COLUMN } from '../../metacooler/matrix'
import { ARROWHEAD_DEFAULTS, arrowheadWindows, callDomains, type ArrowheadSettings, type HighScore } from '../arrowhead'
import { boolParam, numParam, tickedSequences, type TaskRunner } from '../job'
import { matrixSizeOf } from '../tasks/arrowhead'
import type { IntervalsOutput, TableOutput } from '../types'
import { missingSequencesNote, spanOfContig, squareFor, tickedContigIds, usableBlock, validBins, type Span } from './blocks'
import { formatBp } from './labels'

interface Unit {
  name: string
  span: Span
  length: number
}

/** The domains of one sequence, as Juicer writes them: `x1` to `x2`, in base pairs. */
interface Domain extends HighScore {
  sequence: string
  start: number
  end: number
}

export const runArrowhead: TaskRunner = async (job) => {
  const mc = job.mc
  const balance = boolParam(job.params, 'balance', false)
  const value = job.framing.value === '' ? DEFAULT_COUNT_COLUMN : job.framing.value
  const settings: ArrowheadSettings = {
    matrixSize: matrixSizeOf(job.params),
    varThreshold: numParam(job.params, 'varThreshold', ARROWHEAD_DEFAULTS.varThreshold),
    highSignThreshold: numParam(job.params, 'highSignThreshold', ARROWHEAD_DEFAULTS.highSignThreshold),
    maxLowSignThreshold: numParam(job.params, 'maxLowSignThreshold', ARROWHEAD_DEFAULTS.maxLowSignThreshold),
    minLowSignThreshold: numParam(job.params, 'minLowSignThreshold', ARROWHEAD_DEFAULTS.minLowSignThreshold),
    decrementLowSignThreshold: numParam(
      job.params,
      'decrementLowSignThreshold',
      ARROWHEAD_DEFAULTS.decrementLowSignThreshold,
    ),
    minBlockSize: Math.max(0, Math.round(numParam(job.params, 'minBlockSize', ARROWHEAD_DEFAULTS.minBlockSize))),
  }

  const ticked = tickedSequences(job.params, 'sequences')
  if (ticked !== null && ticked.length === 0) {
    job.note('No sequence is ticked, so there is nothing to call domains on.')
    return []
  }
  const { ids, missing } = tickedContigIds(mc, ticked)
  const lengths = mc.chromsizes
  const units: Unit[] = []
  for (const cid of ids) {
    const span = spanOfContig(mc, cid)
    if (span === null) continue
    const name = mc.chromnames[cid]
    units.push({ name, span, length: lengths.get(name) ?? (span.to - span.from) * mc.binsize })
  }
  const said = missingSequencesNote(mc, missing, units.length)
  if (said !== null) job.note(said)
  if (units.length === 0) return []

  // What Juicer was tuned at, said rather than enforced: it picks 5 or 10 kb
  // for itself, and a reader who opened a yeast map at 1 kb asked for 1 kb.
  if (mc.binsize < 5_000 || mc.binsize > 25_000) {
    job.note(
      `Arrowhead was tuned on maps at 5 and 10 kb, and Juicer picks one of the two when it is not told; ` +
        `this map is at ${formatBp(mc.binsize)}, which is what it was run at. Its window of ` +
        `${settings.matrixSize.toLocaleString()} bins is ${formatBp(settings.matrixSize * mc.binsize)} here.`,
    )
  }
  if (!balance) {
    job.note(
      'Read without balancing weights, which is Juicer’s -k NONE. Juicer itself reads a normalised map ' +
        'unless told otherwise.',
    )
  }

  // The counts, and the weights applied here rather than by the reader, so a
  // cell is `NaN` only where it holds a contact and a bin of it was dropped —
  // the window Juicer reads. A balanced read is `NaN` across every dropped
  // row and column, empty cells included, and there the transform differs.
  const block = usableBlock(
    job,
    units.map((unit) => unit.span),
    false,
  )
  const weights = validBins(mc, balance)
  const total = units.reduce((sum, unit) => sum + arrowheadWindows(unit.span.to - unit.span.from, settings.matrixSize).length, 0)
  let done = 0
  const domains: Domain[] = []
  for (const unit of units) {
    await job.breathe()
    const bins = unit.span.to - unit.span.from
    const before = done
    const called = await callDomains(
      bins,
      mc.binsize,
      async (from, to) => {
        const first = unit.span.from + from
        const square = await squareFor(
          job,
          { from: first, to: unit.span.from + to },
          { block, balance: false, value },
        )
        return weights === null ? square.values : weighted(square.values, to - from, weights, first)
      },
      settings,
      async (window, windows) => {
        await job.breathe()
        done = before + window
        job.progress(done, total, `${unit.name}, window ${Math.min(window + 1, windows)} of ${windows}`)
      },
    )
    for (const score of called) {
      domains.push({
        ...score,
        sequence: unit.name,
        start: score.i,
        end: Math.min(unit.length, score.j),
      })
    }
  }
  job.progress(total, total)

  if (domains.length === 0) {
    job.note(
      'No domain was called. Arrowhead needs a deep map: Juicer warns that one with fewer than ' +
        'about 300 million contacts may give few domains.',
    )
    return []
  }

  // How many sit inside another on their sequence: the one thing a tiling of
  // boundaries cannot say, so worth a number.
  const nested = domains.filter((inner) =>
    domains.some(
      (outer) =>
        outer !== inner &&
        outer.sequence === inner.sequence &&
        outer.start <= inner.start &&
        outer.end >= inner.end &&
        (outer.start < inner.start || outer.end > inner.end),
    ),
  ).length
  const count = domains.length
  job.note(
    `${count.toLocaleString()} ${count === 1 ? 'domain' : 'domains'} on ` +
      `${new Set(domains.map((domain) => domain.sequence)).size.toLocaleString()} of ` +
      `${units.length.toLocaleString()} ${units.length === 1 ? 'sequence' : 'sequences'}` +
      (nested === 0 ? ', none inside another.' : `, ${nested.toLocaleString()} of them inside another.`),
  )
  return [domainSet(domains), domainTable(domains, mc.binsize)]
}

/**
 * A square of counts balanced as the reader balances one — `count × w[i] × w[j]`,
 * rounded to float32 — but `0` where there is no contact, whatever its weights.
 */
function weighted(raw: Float32Array, n: number, weights: Float64Array, first: number): Float32Array {
  const out = new Float32Array(n * n)
  for (let r = 0; r < n; r++) {
    const wr = weights[first + r]
    for (let c = 0; c < n; c++) {
      const count = raw[r * n + c]
      out[r * n + c] = count === 0 ? 0 : count * wr * weights[first + c]
    }
  }
  return out
}

/** In genomic order: the sequence as the file has it, then where a domain starts, then where it ends. */
function genomic(domains: readonly Domain[]): Domain[] {
  const rank = new Map<string, number>()
  for (const domain of domains) if (!rank.has(domain.sequence)) rank.set(domain.sequence, rank.size)
  return [...domains].sort(
    (a, b) =>
      (rank.get(a.sequence) ?? 0) - (rank.get(b.sequence) ?? 0) || a.start - b.start || a.end - b.end,
  )
}

/** The domains as a set drawn on the map, one corner each. */
function domainSet(domains: readonly Domain[]): IntervalsOutput {
  const builder = new FeatureBuilder()
  let named = 0
  for (const domain of genomic(domains)) {
    if (domain.end <= domain.start) continue
    builder.add(domain.sequence, domain.start, domain.end, {
      // The corner score, which is what Juicer ranks a domain's evidence by.
      score: domain.score,
      name: `domain_${++named}`,
      detail:
        `corner score ${domain.score.toFixed(3)} · variance ${domain.uVarScore.toFixed(3)} up, ` +
        `${domain.lVarScore.toFixed(3)} down · sign ${domain.upSign.toFixed(3)} up, ${domain.loSign.toFixed(3)} down`,
    })
  }
  return {
    kind: 'intervals',
    id: 'arrowhead-domains',
    label: 'Arrowhead domains',
    payload: { kind: 'features', data: builder.finish() },
    noun: { one: 'domain', many: 'domains' },
    // On the map, as the corner of each square — the picture the corner score
    // is read from, and where a nested domain is seen to be nested.
    display: 'overlay',
    look: 'corner',
  }
}

/** Juicer's `_blocks.bedpe`, as a table: its columns, under its names. */
function domainTable(domains: readonly Domain[], binsize: number): TableOutput {
  return {
    kind: 'table',
    id: 'arrowhead-table',
    label: 'Arrowhead domains, as Juicer writes them',
    columns: [
      { key: 'sequence', label: 'Sequence', kind: 'text' },
      { key: 'start', label: 'Start', kind: 'number', digits: 0, coordinate: 'start' },
      { key: 'end', label: 'End', kind: 'number', digits: 0, coordinate: 'end' },
      { key: 'width', label: 'Width (bins)', kind: 'number', digits: 0 },
      {
        key: 'score',
        label: 'Corner score',
        kind: 'number',
        digits: 6,
        hint: 'The arrowhead difference and sign difference of the two triangles, less their variance.',
      },
      { key: 'uVarScore', label: 'uVarScore', kind: 'number', digits: 6 },
      { key: 'lVarScore', label: 'lVarScore', kind: 'number', digits: 6 },
      { key: 'upSign', label: 'upSign', kind: 'number', digits: 6 },
      { key: 'loSign', label: 'loSign', kind: 'number', digits: 6 },
    ],
    rows: genomic(domains).map((domain) => ({
      sequence: domain.sequence,
      start: domain.start,
      end: domain.end,
      width: Math.round((domain.j - domain.i) / binsize),
      score: domain.score,
      uVarScore: domain.uVarScore,
      lVarScore: domain.lVarScore,
      upSign: domain.upSign,
      loSign: domain.loSign,
    })),
  }
}
