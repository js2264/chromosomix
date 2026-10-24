/**
 * Pairs QC, run: the worker-side half of `analysis/tasks/pairsqc.ts`.
 *
 * Three readings of one library's records, each from wherever it is cheapest to
 * have them:
 *
 * - **`pairtools stats`** — records, mapping, duplicates, cis and trans, pair
 *   types — drawn as figures and written as the table `pairtools stats` writes
 *   (`pairs/stats.ts` is the port, held to pairtools by its golden);
 * - **P(s) by orientation**, the four curves whose convergence is the shortest
 *   separation the library can be believed at (`analysis/orientation.ts`);
 * - **restriction fragments**, with a reference and an enzyme: which pairs are a
 *   fragment ligated to itself or to its neighbour rather than a contact, how
 *   far each read ended from a cut, how many fragments the library saw, and how
 *   coverage follows the sites (`genome/restriction.ts` is the arithmetic).
 *
 * ## One pass, at most
 *
 * A map binned from a `.pairs` had the first two counted by its import (§3.7)
 * and they arrive on `TaskInputs` with nothing read. The third needs the
 * records again — the import could not have placed a read in a fragment it did
 * not know about — so it is one pass over the map's own file
 * (`TaskInputs.mapSource`). A map opened as a matrix kept no records, and all
 * three come from one pass over the `.pairs` the form names.
 *
 * Either pass is **the import's own record reader** (`pairs/bin.ts`'s
 * `binPairs`), run at one bin per sequence so its binning costs nothing, with
 * the restriction counter riding it through `onRecord`: one scan feeds the
 * stats, the orientation curves and the fragments, and §3.7's column handling
 * is not written a second time.
 */

import { contigIndexOf } from '../../genome/naming'
import {
  ORIENTATIONS,
  PAIR_CLASSES,
  RestrictionCounter,
  cutsOfResult,
  enzymeLabel,
  enzymesFor,
  type CutSites,
  type RestrictionStats,
} from '../../genome/restriction'
import { binPairs, type RecordObserver } from '../../pairs/bin'
import { readPairsHeader, type PairsContig } from '../../pairs/format'
import {
  convergenceOf,
  pairtoolsStatsEntries,
  statText,
  type PairStats,
} from '../../pairs/stats'
import type { ByteSource } from '../../types'
import type { SourceSpec } from '../../worker/protocol'
import { binContigMap, CoverageAccumulator } from '../coverage'
import { numParam, strParam, type JobContext, type TaskRunner } from '../job'
import { orientationFigure, type OrientationCounts } from '../orientation'
import { spearman } from '../stats'
import { namedPairs, restrictionParams } from '../tasks/pairsqc'
import type { CurveOutput, CurveSeries, TableOutput, TaskOutput, TaskResult } from '../types'

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export const runPairsQc: TaskRunner = async (job) => {
  const named = namedPairs(job.params)
  const own = job.inputs.mapSource
  const cuts = digestOf(job)

  // What the import counted, where the records are the map's own: a `.pairs`
  // named on the form is another file, and its counts are its own.
  let stats: PairStats | null = named === '' ? (job.inputs.pairsStats ?? null) : null
  let orientation: OrientationCounts | null = named === '' ? (job.inputs.orientation ?? null) : null
  let restriction: RestrictionStats | null = null
  let from = `as ${fileName(job.framing.uri)} was binned`

  // A pass, for the two reasons there are: a file the import never read, and a
  // digest the import knew nothing of.
  const pass = named !== '' || cuts !== null || (stats === null && own !== undefined)
  if (pass) {
    const where = named !== '' ? named : fileName(job.framing.uri)
    const source =
      named !== ''
        ? await openRecords(job, named, job.inputs.sources?.['pairs'])
        : own !== undefined
          ? await openOwn(job, own, where)
          : null
    if (source !== null) {
      try {
        const read = await readRecords(job, where, source, cuts)
        if (read !== null) {
          // The import's counts where it made them, which are the same records
          // counted the same way; the pass's where it did not.
          if (stats === null && read.stats !== null) from = `in one pass over ${where}`
          stats ??= read.stats
          orientation ??= read.orientation
          restriction = read.restriction
        }
      } finally {
        // The caller's to close (`JobContext.openSource`): a contact list left
        // mounted after its one pass is memory the map could have had.
        source.close()
      }
    }
  }

  if (stats === null && orientation === null && restriction === null) {
    if (named === '' && own === undefined && !pass) {
      job.note(
        'This map was opened as a matrix, which keeps no records, so there is nothing to count. ' +
          'Name the .pairs it was binned from.',
      )
    }
    return []
  }

  const outputs: TaskOutput[] = []
  if (orientation !== null) {
    // The convergence said is pairtools', from the same records' `distFreq` —
    // the number `pairsqc-stats` prints and the Pairs statistics card shows —
    // and never the figure's own, which is a second rule with a second answer.
    const figure = orientationOutput(job, orientation, 'pairsqc-orientation', { converge: false })
    if (figure !== null) {
      outputs.push(figure)
      if (stats !== null) job.note(convergenceNote(stats))
    }
  } else if (stats !== null) {
    job.note(
      'The records carry no strand1/strand2 columns, so there is no P(s) by orientation: which ' +
        'way a read pointed is the whole of what that figure is about.',
    )
  }
  if (stats !== null) {
    if (stats.scoped) {
      job.note('The import read part of the file, so these counts are of the part it read.')
    }
    const types = typesOutput(stats)
    if (types !== null) outputs.push(types)
    else job.note('The records carry no pair_type column, so pair types are not counted.')
    outputs.push(cisOutput(stats), statsOutput(stats))
    job.note(
      `The pairtools statistics were counted ${from}: ${stats.total.toLocaleString('en-US')} ` +
        `records, ${stats.totalNodups.toLocaleString('en-US')} of them mapped on both sides and ` +
        'not duplicates.',
    )
  }

  if (restriction !== null) {
    outputs.push(...restrictionOutputs(job, restriction))
    if (cuts !== null) {
      const sites = await coverageAgainstSites(job, cuts, restriction.enzymes)
      if (sites !== null) outputs.push(sites)
    }
  }
  return outputs
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

/**
 * The cuts the restriction step found, or `null` where there was no step.
 *
 * `null` with a sentence wherever the reader asked for one and it is not here,
 * because a run that quietly left the restriction half off a figure the form
 * asked for is a run that reads as a library with nothing to say about it.
 */
function digestOf(job: JobContext): Map<string, CutSites> | null {
  const asked = restrictionParams(job.params)
  const result: TaskResult | undefined = job.inputs.upstream?.['restriction']
  if (asked === null) {
    if (strParam(job.params, 'enzyme', 'none') !== 'none') {
      job.note(
        'An enzyme was chosen with no reference to find its sites in, so there are no ' +
          'restriction statistics.',
      )
    }
    return null
  }
  // A digest the enzymes cannot be read for is a refusal and not a note: the
  // form never offers the Run (`tasks/pairsqc.ts`'s estimate says why), and a
  // stored recipe or a command line that reaches here asked for something that
  // cannot be done — answering it with the pairtools half alone would read as a
  // library with nothing to say about its fragments.
  const chosen = enzymesFor(strParam(asked, 'enzyme', 'none'), strParam(asked, 'sites', ''))
  if (!Array.isArray(chosen)) throw new Error(chosen.refusal)
  if (result === undefined) {
    job.note('The restriction step did not run, so there are no restriction statistics.')
    return null
  }
  const cuts = cutsOfResult(result)
  if (cuts === null) {
    job.note('The restriction step found no sequence to cut, so there are no restriction statistics.')
    return null
  }
  return cuts
}

/** The enzymes a run named, as one word — `DpnII`, `DpnII+HinfI` — for the labels. */
function enzymesNamed(job: JobContext): string {
  const chosen = enzymesFor(strParam(job.params, 'enzyme', 'none'), strParam(job.params, 'sites', ''))
  return Array.isArray(chosen) ? enzymeLabel(chosen) : ''
}

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

const PLUS = 0x2b
const MINUS = 0x2d
const BANG = 0x21
const D = 0x44

/** A strand byte as the counter reads it, without a string made per record. */
function strandWord(byte: number): string {
  return byte === PLUS ? '+' : byte === MINUS ? '-' : '.'
}

/**
 * One pass over a `.pairs`: what `pairtools stats` counts, the four orientation
 * curves, and — with a digest — the restriction fragments, all from one scan.
 *
 * **Through `binPairs` at the coarsest possible grid**, as P(s)'s own read of a
 * named file is (`run/expected.ts`): one bin per sequence makes the binning
 * free, and what the pass is for is the counters it carries. The restriction
 * counter rides it through `onRecord`, which hands each record over exactly as
 * the stats counter is handed it — the header's own name strings for every
 * sequence it declares, so a record allocates nothing, and a name decoded only
 * where the header lacks it.
 */
async function readRecords(
  job: JobContext,
  where: string,
  source: ByteSource,
  cuts: Map<string, CutSites> | null,
): Promise<{
  stats: PairStats | null
  orientation: OrientationCounts | null
  restriction: RestrictionStats | null
} | null> {
  job.progress(0, 1, 'reading records')
  const header = await readPairsHeader(source)
  const counter = cuts === null ? null : counterFor(job, cuts, header.contigs)
  const names = header.contigs.map((contig) => contig.name)
  const decoder = new TextDecoder()
  const nameOf = (line: Uint8Array, c: number, from: number, to: number): string => {
    if (c >= 0) return names[c]
    if (to - from === 1 && line[from] === BANG) return '!'
    return decoder.decode(line.subarray(from, to))
  }
  const onRecord: RecordObserver | undefined =
    counter === null
      ? undefined
      : (line, c1, c1From, c1To, c2, c2From, c2To, p1, p2, s1, s2, tFrom, tTo) => {
          const duplicate = tTo - tFrom === 2 && line[tFrom] === D && line[tFrom + 1] === D
          counter.add(
            nameOf(line, c1, c1From, c1To),
            p1 < 0 ? Number.NaN : p1,
            strandWord(s1),
            nameOf(line, c2, c2From, c2To),
            p2 < 0 ? Number.NaN : p2,
            strandWord(s2),
            duplicate,
          )
        }

  let longest = 0
  for (const contig of header.contigs) longest = Math.max(longest, contig.length)
  const binned = await binPairs(source, {
    // One bin per sequence: the cheapest grid that exists and is not a map.
    binSize: Math.max(1, longest),
    contigs: header.contigs,
    columns: header.columns,
    onProgress: (done, total) => job.progress(done, total, 'reading records'),
    cancelled: () => job.cancelled(),
    ...(onRecord === undefined ? {} : { onRecord }),
  })
  job.throwIfCancelled()
  if (binned === null) return null
  if (binned.skippedUnknownContig > 0 && counter !== null) {
    // Said because it is the one place the two counts part: pairtools stats
    // counts these with the rest, and the fragments cannot place them.
    job.note(
      `${binned.skippedUnknownContig.toLocaleString('en-US')} records of ${where} name a sequence ` +
        'its header does not declare.',
    )
  }
  return {
    stats: binned.stats ?? null,
    orientation: binned.orientation ?? null,
    restriction: counter === null ? null : counter.result(),
  }
}

/**
 * The counter for this digest, with the lengths it cuts each sequence to.
 *
 * The cuts are the reference's, by its names; the lengths are the `.pairs`
 * header's and then the map's, since the analysis worker holds no reference to
 * ask — and a library's header declares the very assembly its reads were mapped
 * to. Names are matched across spellings by the counter (§5.9). A reference
 * sequence neither declares is left out of the fragments, and said to be.
 */
function counterFor(
  job: JobContext,
  cuts: Map<string, CutSites>,
  declared: readonly PairsContig[],
): RestrictionCounter {
  const lengths = new Map<string, number>()
  for (const contig of declared) lengths.set(contig.name, contig.length)
  const mc = job.mc
  for (const name of mc.chromnames) {
    const length = mc.chromsizes.get(name)
    if (length !== undefined && !lengths.has(name)) lengths.set(name, length)
  }
  const known = [...lengths.keys()]
  const unplaced = [...cuts.keys()].filter(
    (name) => !lengths.has(name) && contigIndexOf(known, name) < 0,
  )
  if (unplaced.length > 0) {
    job.note(
      `${unplaced.length.toLocaleString('en-US')} of the reference's sequences ` +
        `(${unplaced.slice(0, 3).join(', ')}${unplaced.length > 3 ? ', …' : ''}) are in neither ` +
        'the .pairs header nor the map, so their fragments are not counted.',
    )
  }
  return new RestrictionCounter(cuts, lengths, enzymesNamed(job))
}

/** A path's or an address's last part, for a sentence. */
function fileName(uri: string): string {
  const path = uri.split('::')[0].split(/[?#]/)[0]
  const last = path.split(/[\\/]/).filter((part) => part !== '').pop()
  return last ?? uri
}

/**
 * The map's own `.pairs`, opened for its bytes (`TaskInputs.mapSource`).
 *
 * Through `openSource`, the road a dropped file takes, because the map's source
 * is exactly that: a `SourceSpec` the reader opened, local or remote. A venue
 * that cannot open one says so rather than reading nothing.
 */
async function openOwn(job: JobContext, spec: SourceSpec, where: string): Promise<ByteSource | null> {
  if (job.openSource === undefined) {
    job.note(`Reading ${where} again needs a venue that can open a file it was handed, and this one cannot.`)
    return null
  }
  try {
    return await job.openSource(spec)
  } catch (error) {
    job.note(`Could not open ${where}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/**
 * The bytes of a `.pairs` a run was given, by whichever road reaches them.
 *
 * A file **handed** to the form comes first — dropped, chosen, or picked out of a
 * connected place — because its source is exactly what the reader gave and the
 * name beside it is only the record of it. An address is fetched as it stands,
 * and a path is read where the venue has a filesystem, which is a shell's whole
 * case and a worker's impossible one: each venue says which it is by the
 * capability it answers (`JobContext.openFile`).
 *
 * Shared with P(s), whose retired `pairsUri` (`run/expected.ts`) is read the
 * same way, so the two tasks cannot come to disagree about which file a name
 * means.
 */
export async function openRecords(
  job: JobContext,
  uri: string,
  handed: SourceSpec | undefined,
): Promise<ByteSource | null> {
  const remote = /^(https?|s3):\/\//i.test(uri)
  const open =
    handed !== undefined && job.openSource !== undefined
      ? () => job.openSource!(handed)
      : remote && job.openBytes !== undefined
        ? () => job.openBytes!(uri)
        : !remote && job.openFile !== undefined
          ? () => job.openFile!(uri)
          : null
  if (open === null) {
    job.note(
      remote
        ? `Reading ${uri} needs a venue that can fetch an address, and this one reads local ` +
            'files only. Fetch it first and name the file, or run it in the app.'
        : `“${uri}” is not an address this can fetch, and the file is no longer in hand — a ` +
            'dropped file is kept for the session it was dropped in. Drop it on the form again, ' +
            'or name it on a `chromosomix` command line, which reads it from disk.',
    )
    return null
  }
  try {
    return await open()
  } catch (error) {
    job.note(`Could not open ${uri}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// P(s) by orientation
// ---------------------------------------------------------------------------

/**
 * The four orientation curves as a figure — or `null`, with a sentence, where
 * fewer than two have anything — and, where `converge` asks for it, the figure's
 * own sentence about where they meet.
 *
 * One function for both tasks that draw it: P(s) for a stored run that still
 * asks (`run/expected.ts`), and Pairs QC, which is where the figure lives now.
 * Re-binned at `factor` (P(s)'s own `factor` where it has one, 1.1 here),
 * normalised over the records in all four (`orientationFigure`).
 *
 * **Pairs QC states no convergence of the figure's own.** The figure's rule —
 * the four within a tenth in log space, walking down from the long end — and
 * pairtools' — any of them five per cent off the four's mean, the furthest such
 * bin — are two answers to one question, and the task that also prints
 * `pairtools stats` must give one: so it passes `converge: false` and says
 * pairtools' instead ({@link convergenceNote}). P(s)'s retired curve keeps the
 * sentence it always had.
 */
export function orientationOutput(
  job: JobContext,
  counts: OrientationCounts,
  id: string,
  options: { factor?: number; converge?: boolean } = {},
): CurveOutput | null {
  const factor = options.factor ?? Math.max(1.01, numParam(job.params, 'factor', 1.1))
  const figure = orientationFigure(counts, { factor })
  if (figure === null) {
    job.note(
      'Fewer than two orientations have any cis record in them, so there is nothing to compare. ' +
        'A file whose strand columns are all `.` reads this way.',
    )
    return null
  }

  if (options.converge !== false) job.note(
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
    id,
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

// ---------------------------------------------------------------------------
// pairtools stats
// ---------------------------------------------------------------------------

/**
 * Where the four orientations meet, by pairtools' rule (`convergenceOf`): the
 * edge after the furthest separation bin at which any orientation strays more
 * than five per cent from the four's mean — `summary/dist_freq_convergence/
 * convergence_dist` in the table below, to the base pair.
 */
export function convergenceNote(stats: PairStats): string {
  const found = convergenceOf(stats)
  const share = (count: number): string =>
    stats.cis > 0 ? `${((100 * count) / stats.cis).toFixed(1)} %` : '—'
  if (found.distance === null) {
    return (
      'No orientation strays more than 5 % from the mean of the four at any separation, so ' +
      'pairtools reports no convergence distance: the four agree from the first base pair.'
    )
  }
  // The caveat is pairtools' own rule read honestly: the *furthest* bin with a
  // stray sets the distance, so a sparse tail of chance strays can put it far
  // past where the curves lie together, as on a small library it does.
  return (
    `The four orientations converge at ${found.distance.toLocaleString('en-US')} bp by ` +
    `pairtools' rule: past the last separation bin at which one of them ` +
    `(${found.strands ?? '?'}) strays more than 5 % from the mean of the four, with ` +
    `${share(found.belowAll)} of the cis pairs below it. The furthest such bin sets it, so a ` +
    'sparse tail of chance strays can put it well past where the curves lie together.'
  )
}

/** Bars over a list, at `0, 1, 2…`, named by `ticks` — one figure's whole abscissa. */
function listAxis(ticks: readonly string[]): Float64Array {
  return Float64Array.from(ticks, (_, at) => at)
}

/** Every pair type and how many records had it, most common first; `null` without the column. */
function typesOutput(stats: PairStats): CurveOutput | null {
  if (stats.pairTypes.length === 0) return null
  const ticks = stats.pairTypes.map(([type]) => type)
  return {
    kind: 'curve',
    id: 'pairsqc-types',
    label: 'Pair types',
    series: [
      {
        name: 'records',
        x: listAxis(ticks),
        y: Float64Array.from(stats.pairTypes, ([, count]) => count),
        mark: 'bars',
        n: stats.total,
      },
    ],
    xLabel: 'Pair type',
    yLabel: 'Records',
    xScale: 'linear',
    yScale: 'linear',
    xTicks: ticks,
  }
}

/**
 * Cis and trans, and cis at least 1, 2, 4, 10, 20 and 40 kb apart, as shares
 * of the pairs mapped on both sides and not duplicated — pairtools'
 * `summary/frac_cis*` and its denominator, with trans beside cis.
 *
 * Named on the axis by pairtools' own keys, so a bar reads as the line of a
 * `.stats` file it was drawn from.
 */
function cisOutput(stats: PairStats): CurveOutput {
  const ticks = ['cis', 'trans', ...stats.cisAtLeast.map(([kb]) => `cis_${kb}kb+`)]
  const counts = [stats.cis, stats.trans, ...stats.cisAtLeast.map(([, count]) => count)]
  const share = (count: number): number => (stats.totalNodups > 0 ? count / stats.totalNodups : Number.NaN)
  return {
    kind: 'curve',
    id: 'pairsqc-cis',
    label: 'Cis and trans',
    series: [
      {
        name: 'fraction',
        x: listAxis(ticks),
        y: Float64Array.from(counts, share),
        mark: 'bars',
        n: stats.totalNodups,
      },
    ],
    xLabel: 'Pairs',
    yLabel: 'Share of the mapped pairs that are not duplicates',
    xScale: 'linear',
    yScale: 'linear',
    // The whole of a fraction, for the reason the cis/trans task gives: a fitted
    // axis draws two libraries that agree as two that do not.
    yDomain: [0, 1],
    xTicks: ticks,
  }
}

/**
 * The summary `pairtools stats` writes, as a table: every entry but the three
 * long lists — chromosome pairs, the separation histogram and the chromsizes —
 * which the figures above draw or which are the header's. Each value spelled as
 * pairtools spells it (`statText`), so a row can be laid beside the line of a
 * `.stats` file and compared character for character.
 */
function statsOutput(stats: PairStats): TableOutput {
  const rows = pairtoolsStatsEntries(stats)
    .filter(([key]) => !/^(chrom_freq|dist_freq|chromsizes)\//.test(key))
    .map(([key, value]) => ({ statistic: key, value: statText(value) }))
  return {
    kind: 'table',
    id: 'pairsqc-stats',
    label: 'pairtools stats',
    columns: [
      { key: 'statistic', label: 'Statistic', kind: 'text' },
      { key: 'value', label: 'Value', kind: 'text' },
    ],
    rows,
  }
}

// ---------------------------------------------------------------------------
// Restriction fragments
// ---------------------------------------------------------------------------

/** The four restriction outputs, and the sentence about what was counted. */
function restrictionOutputs(job: JobContext, stats: RestrictionStats): TaskOutput[] {
  const enzymes = stats.enzymes === '' ? 'the enzyme' : stats.enzymes
  job.note(
    `${stats.counted.toLocaleString('en-US')} pairs were placed in ${enzymes}'s ` +
      `${stats.fragments.total.toLocaleString('en-US')} fragments` +
      (stats.unassigned > 0
        ? `; ${stats.unassigned.toLocaleString('en-US')} more had an end on a sequence the ` +
          'reference has not got, and are not classified.'
        : '.'),
  )
  return [
    classesOutput(stats, enzymes),
    classesTable(stats, enzymes),
    distanceOutput(stats, enzymes),
    fragmentsOutput(stats, enzymes),
  ]
}

/** Each class, stacked by the strands of its two ends. */
function classesOutput(stats: RestrictionStats, enzymes: string): CurveOutput {
  const ticks = [...PAIR_CLASSES]
  const x = listAxis(ticks)
  return {
    kind: 'curve',
    id: 'pairsqc-classes',
    label: `Pair classes by orientation · ${enzymes}`,
    series: ORIENTATIONS.map(
      (orientation): CurveSeries => ({
        name: orientation,
        x,
        y: Float64Array.from(PAIR_CLASSES, (name) => stats.byOrientation[name][orientation]),
        mark: 'bars',
        stack: 'orientation',
      }),
    ),
    xLabel: 'Class',
    yLabel: 'Pairs',
    xScale: 'linear',
    yScale: 'linear',
    xTicks: ticks,
  }
}

/** The same counts as a table, with each class's share of the pairs placed. */
function classesTable(stats: RestrictionStats, enzymes: string): TableOutput {
  return {
    kind: 'table',
    id: 'pairsqc-classes-table',
    label: `Pair classes · ${enzymes}`,
    columns: [
      { key: 'class', label: 'Class', kind: 'text' },
      { key: 'pairs', label: 'Pairs', kind: 'number' },
      { key: 'share', label: 'Share', kind: 'number', digits: 4 },
      ...ORIENTATIONS.map((orientation) => ({
        key: orientation,
        label: orientation,
        kind: 'number' as const,
      })),
    ],
    rows: PAIR_CLASSES.map((name) => ({
      class: name,
      pairs: stats.classes[name],
      share: stats.counted > 0 ? stats.classes[name] / stats.counted : Number.NaN,
      ...stats.byOrientation[name],
    })),
  }
}

/**
 * How far each end was from the next cut in the direction it reads, by strand.
 *
 * At each bin's **left edge**, as pairtools names its separation bins, so a row
 * of the table is a bin by the number that starts it; and only from the first
 * bin either strand has anything in to the last, since the empty decades either
 * side are not a distance anybody measured. The first bin, `[0, 1)`, is never
 * drawn: a distance is at least one base.
 */
function distanceOutput(stats: RestrictionStats, enzymes: string): CurveOutput {
  const edges = stats.distanceEdges
  const plus = stats.distance['+']
  const minus = stats.distance['-']
  let first = edges.length
  let last = -1
  for (let i = 1; i < edges.length; i++) {
    if (plus[i] > 0 || minus[i] > 0) {
      first = Math.min(first, i)
      last = i
    }
  }
  const at = last < first ? [] : Array.from({ length: last - first + 1 }, (_, k) => first + k)
  const x = Float64Array.from(at, (i) => edges[i])
  return {
    kind: 'curve',
    id: 'pairsqc-distance',
    label: `Distance from a read to the next ${enzymes} cut`,
    series: [
      { name: '+', x, y: Float64Array.from(at, (i) => plus[i]) },
      { name: '-', x, y: Float64Array.from(at, (i) => minus[i]) },
    ],
    xLabel: 'Distance to the cut (bp, bin start)',
    yLabel: 'Read ends',
    xScale: 'log',
    yScale: 'linear',
  }
}

/** How many ends each fragment holds, with how many of them held any in the label. */
function fragmentsOutput(stats: RestrictionStats, enzymes: string): CurveOutput {
  const { total, seen, binLabels, counts } = stats.fragments
  return {
    kind: 'curve',
    id: 'pairsqc-fragments',
    label:
      `Read ends per ${enzymes} fragment · ${seen.toLocaleString('en-US')} / ` +
      `${total.toLocaleString('en-US')} fragments seen`,
    series: [
      {
        name: 'fragments',
        x: listAxis(binLabels),
        y: Float64Array.from(counts),
        mark: 'bars',
        n: total,
      },
    ],
    xLabel: 'Read ends in the fragment',
    yLabel: 'Fragments',
    xScale: 'linear',
    yScale: 'linear',
    xTicks: [...binLabels],
  }
}

// ---------------------------------------------------------------------------
// Coverage against sites
// ---------------------------------------------------------------------------

/**
 * The fewest bins a number of sites must hold for the mean line to be drawn
 * there: a mean over one or two bins is those bins, and five is the fewest that
 * read as a trend rather than as the bins themselves.
 */
const MEAN_MIN_BINS = 5
/** {@link MEAN_MIN_BINS} as the note says it. */
const MEAN_MIN_BINS_WORD = 'five'

/**
 * Each bin's coverage against the cuts in it, with the mean coverage at each
 * number of cuts, and Spearman's ρ between the two.
 *
 * **Coverage is the Coverage task's own** (`analysis/coverage.ts`): the raw
 * contacts of every pixel touching the bin, cis and trans, its own diagonal
 * pixel counted once — `cooltools.coverage(ignore_diags=0)`'s total less that
 * pixel, which cooltools adds at both its ends. A bin's sites are the cuts `c`
 * with `start <= c < end`, on the map's grid as it is read.
 *
 * Only the bins the reference speaks for: a sequence it has not got has no
 * sites anybody counted, and its bins would read as zero. Of the rest, a bin
 * with neither a contact nor a cut is left out of the correlation **and of the
 * mean line**, which average the same bins; and the mean is drawn only at a
 * number of sites {@link MEAN_MIN_BINS} bins share.
 *
 * The points are **sorted by their number of sites**, the bins of one number in
 * the order the genome holds them, so the mean shares their abscissa: one row
 * of the table per bin, its sites, its coverage and the mean of the bins with
 * as many sites, which is a table the two series can be read across.
 */
async function coverageAgainstSites(
  job: JobContext,
  cuts: Map<string, CutSites>,
  enzymes: string,
): Promise<CurveOutput | null> {
  const mc = job.mc
  const contigs: Array<{ startBin: number; bins: number }> = []
  for (let cid = 0; cid < mc.nContigs; cid++) {
    const [from, to] = mc.contigExtent(cid)
    contigs.push({ startBin: from, bins: Math.max(0, to - from) })
  }

  // The sites first, which cost nothing: which bins the reference speaks for,
  // and how many cuts fall in each.
  const cutNames = [...cuts.keys()]
  const sites = new Float64Array(mc.nBins)
  const spoken = new Uint8Array(mc.nBins)
  for (let cid = 0; cid < mc.nContigs; cid++) {
    const at = contigIndexOf(cutNames, mc.chromnames[cid])
    if (at < 0) continue
    const { startBin, bins } = contigs[cid]
    spoken.fill(1, startBin, startBin + bins)
    // A site counts once, at its top-strand cut, as the contract's `c` is.
    for (const cut of cuts.get(cutNames[at])?.top ?? []) {
      const bin = startBin + Math.floor(cut / mc.binsize)
      if (bin < startBin + bins) sites[bin]++
    }
  }

  job.progress(0, 1, 'reading pixels')
  const accumulator = new CoverageAccumulator(mc.nBins, binContigMap(contigs, mc.nBins))
  await mc.scanPixels({
    onChunk: (chunk) => {
      job.throwIfCancelled()
      accumulator.addPixels(chunk.bin1, chunk.bin2, chunk.count, chunk.length, null)
    },
    onProgress: (done, total) => job.progress(done, total, 'reading pixels'),
  })
  job.throwIfCancelled()
  const coverage = accumulator.finish().total

  const kept: number[] = []
  let empty = 0
  for (let bin = 0; bin < mc.nBins; bin++) {
    if (spoken[bin] === 0) continue
    if (coverage[bin] === 0 && sites[bin] === 0) {
      empty++
      continue
    }
    kept.push(bin)
  }
  if (kept.length === 0) {
    job.note('No bin of the map lies on a sequence the reference has, so coverage is not set against sites.')
    return null
  }
  kept.sort((a, b) => sites[a] - sites[b] || a - b)

  const x = Float64Array.from(kept, (bin) => sites[bin])
  const y = Float64Array.from(kept, (bin) => coverage[bin])
  // The mean at each number of sites, over exactly the bins plotted — and only
  // where {@link MEAN_MIN_BINS} of them share it. A number of sites one or two
  // bins hold is a repeat or an rDNA array as often as not, and a line through
  // their twelve thousand contacts draws the eye to them rather than to the
  // trend; their points stay, with the mean left `NaN` — a gap in the line and
  // an empty cell in the table.
  const mean = new Float64Array(kept.length)
  for (let start = 0; start < kept.length; ) {
    let end = start
    let sum = 0
    while (end < kept.length && x[end] === x[start]) sum += y[end++]
    mean.fill(end - start >= MEAN_MIN_BINS ? sum / (end - start) : Number.NaN, start, end)
    start = end
  }
  const rho = spearman(x, y)
  const rhoText = Number.isFinite(rho) ? rho.toFixed(3) : 'undefined'
  job.note(
    `Spearman ρ = ${rhoText} between the ${enzymes} sites in a bin and its coverage, over ` +
      `${kept.length.toLocaleString('en-US')} bins of ${mc.binsize.toLocaleString('en-US')} bp` +
      (empty === 0
        ? ''
        : `; ${empty.toLocaleString('en-US')} ${empty === 1 ? 'bin' : 'bins'} with neither ` +
          `${empty === 1 ? 'was' : 'were'} left out`) +
      `. The mean is drawn where at least ${MEAN_MIN_BINS_WORD} bins share a number of sites.`,
  )
  return {
    kind: 'curve',
    id: 'pairsqc-sites',
    label: `Coverage against ${enzymes} sites · ρ = ${rhoText}`,
    series: [
      { name: 'bins', x, y, mark: 'points', n: kept.length },
      { name: 'mean', x, y: mean },
    ],
    xLabel: 'Restriction sites in the bin',
    yLabel: 'Contacts (coverage)',
    xScale: 'linear',
    yScale: 'linear',
  }
}
