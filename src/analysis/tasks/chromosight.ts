/**
 * Pattern detection, as a descriptor — the one task that *calls* something.
 *
 * SPECS §18.9 said no loop calling, and gave a reason worth restating before
 * reversing it: a HiCCUPS-class caller needs false-discovery control across
 * several local backgrounds, and a half-good one inside a viewer is a liability
 * *precisely because its output looks like a result*. That argument is about
 * writing a caller. This is not one. It is a port of chromosight — published,
 * benchmarked, and carrying the two things the objection asked for: a background
 * model (the distance law the map is detrended by) and false-discovery control
 * (Benjamini-Hochberg over the Fisher-transformed correlations). What
 * `analysis/chromosight.ts` adds is the arithmetic being dense instead of
 * sparse, and `test/golden/analysis/chromosight.json` is that package's own
 * output over `demo/yeast/`, compared cell for cell.
 *
 * So the honest form of §18.9's rule is: **no caller of this app's own
 * invention**. A number a reader can reproduce with `chromosight detect` on the
 * same file is not the failure mode that paragraph is about — it is the opposite
 * of it, and the alternative is a viewer that shows a loop set it cannot produce
 * and cannot check.
 *
 * **The pattern is the parameter.** Loops, borders, hairpins, centromeres and
 * stripes are one computation with different templates, so they are one row with
 * a picker rather than five rows — and every threshold beneath the picker
 * defaults to the value chromosight tuned *for that template*, which is why the
 * defaults move when the picker does.
 */

import type {
  AnalysisContext,
  AnalysisTask,
  CostEstimate,
  ParamSpec,
  Params,
  TaskAvailability,
} from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { CHROMOSIGHT_PRESETS, type ChromosightPreset } from '../chromosightPresets'
import { bandTiles } from '../tiles'
import { BALANCE_PARAM } from './shared'

/**
 * The largest **band** this will hold, in cells.
 *
 * It was a cap on the sequence — 8,192 bins — and that was a cap on the wrong
 * thing. What the scan holds is three arrays of `(keepDistance + 1) × n` cells:
 * the raw contacts, the detrended map and the correlation map. None of them is
 * `n²`, and none ever was: `analysis/chromosight.ts` has banded every one of its
 * objects from the start. Only the *read* was square, so the limit that fell out
 * of it scaled with the chromosome rather than with the scan distance — and
 * refused mouse chr18 at 10 kb, which the arithmetic could do a hundred times
 * over, while a short sequence with a 20 Mb scan distance sailed through.
 *
 * 96 million cells is about 1.9 GB across the three, each comfortably inside the
 * 2 GiB one-array ceiling (`constants.ts`). What it buys: mouse chr1 at 5 kb
 * with the default 2 Mb scan distance is 16 million, and the whole mouse genome
 * fits at every resolution this file carries. What it still refuses is a *deep*
 * scan on a *fine* grid — chr1 at 1 kb reaching 2 Mb is 394 million — and the
 * refusal names the two ways out, because both are real choices rather than a
 * machine to buy.
 */
export const MAX_SCAN_CELLS = 96_000_000

/**
 * Cells the scan will hold for a sequence of `n` bins.
 *
 * The band's own shape, so the estimate, the planner and the refusal all count
 * the same thing. `largestKernel` is a template's size and never more than a few
 * dozen; the scan distance is what moves this number.
 */
export function scanCellsFor(n: number, maxDistBins: number, largestKernel: number): number {
  return (Math.min(maxDistBins, n) + largestKernel + 1) * n
}

/**
 * How far from the diagonal the run reads a sequence of `n` bins: the `hi` it
 * hands `bandFor`, and so the depth the estimate counts that walk's strips at.
 *
 * {@link scanCellsFor}'s band less its main diagonal, stopped at the sequence's
 * own last bin as `bandFor` stops it — a band cannot reach past the end of what
 * it is a band of.
 */
function readReach(n: number, maxDistBins: number, largestKernel: number): number {
  return Math.min(Math.min(maxDistBins, n) + largestKernel, Math.max(0, n - 1))
}

/** The preset a parameter set names, falling back to loops. */
export function presetFor(params: Params): ChromosightPreset {
  const name = typeof params.pattern === 'string' ? params.pattern : ''
  return CHROMOSIGHT_PRESETS.find((preset) => preset.name === name) ?? CHROMOSIGHT_PRESETS[0]
}

/**
 * A threshold's value: the preset's, or the reader's where they took them over.
 *
 * This is chromosight's `auto`, and the gate exists because the parameter model
 * has static defaults while these numbers are **per template**: borders are
 * called at 0.15 and loops at 0.3, and a form that baked one of them into the
 * box would silently report the other pattern at the wrong threshold. So the
 * numbers are hidden until the reader asks for them, and until then every one of
 * them follows the picker. Both states are in the provenance, so a TSV says
 * which it was.
 */
export function threshold(params: Params, key: string, preset: number): number {
  if (params.thresholds !== 'custom') return preset
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : preset
}

/** Whether the reader has taken the thresholds over. */
function custom(params: Params): boolean {
  return params.thresholds === 'custom'
}

/**
 * A preset's base-pair distance, in bins of the file in front of the reader.
 *
 * **The one bin-size division left in this task**, and it divides upstream's
 * number rather than the reader's. `chromosightPresets.ts` is generated from the
 * installed package and must not be edited, so the presets are in base pairs and
 * always will be; the three boxes a reader can take over are in bins, because a
 * scan band, a distance from the diagonal and a gap between two calls are all
 * counts of the grid's own cells (§18.2).
 *
 * `0` stays `0`, because zero `maxDist` is not a short band — it is how upstream
 * says *this pattern lives on the diagonal*, and a floor of one bin there would
 * turn a border scan into a loop scan one diagonal wide. Everything else is at
 * least one bin: a threshold rounded down to nothing is a threshold switched
 * off, which is a worse answer than one that is a bin out.
 */
function presetBins(bp: number, binsize: number): number {
  if (bp === 0) return 0
  return Math.max(1, Math.round(bp / (binsize > 0 ? binsize : 1)))
}

/**
 * A distance threshold in **bins**: the reader's number, or the preset's.
 *
 * {@link threshold}'s shape for the three settings whose unit changed, so the
 * `auto` gate is the same gate — until the reader presses *set them myself*
 * every one of them follows the template, and both states are in the provenance.
 */
export function distanceBins(
  params: Params,
  key: string,
  presetBp: number,
  binsize: number,
): number {
  if (!custom(params)) return presetBins(presetBp, binsize)
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : presetBins(presetBp, binsize)
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'pattern',
    label: 'pattern',
    default: 'loops',
    hint: 'Every threshold below follows the template: they were tuned together.',
    options: CHROMOSIGHT_PRESETS.map((preset) => ({
      value: preset.name,
      label: preset.name.replace(/_/g, ' '),
      hint: preset.blurb,
    })),
  },
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
  },
  {
    kind: 'choice',
    key: 'thresholds',
    label: 'thresholds',
    default: 'preset',
    options: [
      {
        value: 'preset',
        label: 'from the pattern',
        hint: 'chromosight’s own numbers for the template above — what chromosight detect uses.',
      },
      {
        value: 'custom',
        label: 'set them myself',
        hint: 'The boxes start at the loops preset; check them against the pattern you picked.',
      },
    ],
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'pearson',
    label: 'score threshold',
    hint: 'The correlation a pixel must reach to be a candidate; lower finds more, and more of it is noise.',
    default: 0.3,
    min: 0,
    max: 1,
    step: 0.01,
    slider: true,
    when: custom,
    section: 'Scan',
  },
  // **The three distances are in bins**, and the defaults are the loops preset's
  // own numbers in bins of the 2 kb map its templates were drawn at — which is
  // what the *set them myself* hint above promises the boxes start at. A scan
  // band is a count of diagonals, a distance from the diagonal is a count of
  // cells, and two calls are one smear or two calls by how many bins apart their
  // pixels are; none of the three is a length of genome, and asked in base pairs
  // every one of them was divided by the bin size before it meant anything.
  {
    kind: 'number',
    key: 'minDist',
    label: 'nearest to the diagonal',
    default: 10,
    min: 0,
    integer: true,
    unit: 'bins',
    when: custom,
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'maxDist',
    label: 'furthest from the diagonal',
    hint: 'The scan band: widening it costs time in proportion, and zero puts the pattern on the diagonal.',
    default: 1_000,
    min: 0,
    integer: true,
    unit: 'bins',
    when: custom,
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'minSeparation',
    label: 'nearest two calls may be',
    hint: 'Closer than this on both axes and only the higher-scoring one is kept.',
    default: 3,
    min: 0,
    integer: true,
    unit: 'bins',
    when: custom,
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'iterations',
    label: 'refinement passes',
    hint: 'Each pass re-scans with the pileup of what the last one found as its template.',
    default: 1,
    min: 1,
    max: 5,
    integer: true,
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'maxPercUndetected',
    label: 'most undetectable pixels a window may hold',
    default: 50,
    min: 0,
    max: 100,
    unit: '%',
    slider: true,
    when: custom,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'maxPercZero',
    label: 'most empty pixels a window may hold',
    default: 10,
    min: 0,
    max: 100,
    unit: '%',
    slider: true,
    when: custom,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'nMads',
    label: 'detectability cut',
    hint: 'Median absolute deviations below the median coverage, and only read where the file has no weights.',
    default: 5,
    min: 1,
    max: 20,
    step: 0.5,
    slider: true,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'maxQvalue',
    label: 'report down to a q-value of',
    hint: 'Benjamini-Hochberg over every call; 1 keeps them all and still reports the number.',
    default: 1,
    min: 0,
    max: 1,
    step: 0.01,
    slider: true,
    section: 'Quality',
  },
  BALANCE_PARAM,
]

/**
 * The scan distance in bins, and the widest template, as the gate counts them.
 *
 * The two numbers that decide how wide the band is — and therefore, now that the
 * square is gone, the only two settings that decide whether a sequence can be
 * scanned at all.
 */
export function bandShapeOf(
  params: Params,
  binsize: number,
): { maxDistBins: number; largestKernel: number } {
  const preset = presetFor(params)
  return {
    // A band of at least one diagonal, including for the on-diagonal patterns
    // whose `maxDist` is zero: the scan still reads the diagonal itself.
    maxDistBins: Math.max(1, distanceBins(params, 'maxDist', preset.maxDist, binsize)),
    largestKernel: preset.sizes.reduce((most, kernel) => Math.max(most, kernel), 0),
  }
}

/**
 * The sequences a run will scan, after the ticks and the size gate — and what
 * reading them costs: the strips `bandFor` walks them in, one read each, and the
 * cells of the widest one's band, which is the most held at a time.
 */
function chosen(
  context: AnalysisContext,
  params: Params,
): { scanned: number; bins: number; strips: number; cells: number; skipped: number } {
  const ticked = Array.isArray(params.sequences)
    ? new Set(params.sequences.filter((name): name is string => typeof name === 'string'))
    : null
  const { maxDistBins, largestKernel } = bandShapeOf(params, context.binsize)
  let scanned = 0
  let widest = 0
  let strips = 0
  let skipped = 0
  for (const contig of context.contigs) {
    if (ticked !== null && !ticked.has(contig.name)) continue
    if (scanCellsFor(contig.bins, maxDistBins, largestKernel) > MAX_SCAN_CELLS) {
      skipped++
      continue
    }
    scanned++
    widest = Math.max(widest, contig.bins)
    strips += bandTiles(contig.bins, readReach(contig.bins, maxDistBins, largestKernel))
  }
  const cells = widest === 0 ? 0 : (readReach(widest, maxDistBins, largestKernel) + 1) * widest
  return { scanned, bins: widest, strips, cells, skipped }
}

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const preset = presetFor(params)
  const { scanned, bins, strips, cells, skipped } = chosen(context, params)
  if (scanned === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        skipped > 0
          ? 'Every chosen sequence would need a band bigger than a scan can hold. The band is ' +
            'the scan distance times the sequence, so there are two ways in: bring “furthest ' +
            'from the diagonal” down, or open the file at a coarser resolution.'
          : 'Tick at least one sequence.',
    }
  }

  const band = Math.max(
    1,
    Math.min(bandShapeOf(params, context.binsize).maxDistBins, bins),
  )
  const size = preset.sizes[0]
  const iterations =
    typeof params.iterations === 'number' && Number.isFinite(params.iterations)
      ? Math.max(1, Math.round(params.iterations))
      : 1
  const passes = preset.sizes.length * iterations
  // Multiply-accumulates, not bytes, because this is the number that decides
  // whether the run is worth starting: the read is one band per sequence and is
  // over in a moment, and then every pixel of the band is correlated against
  // `size²` template cells. Stating the bytes alone would price the cheap half.
  const operations = scanned * bins * band * size * size * passes

  // The band and not the square, in the words and in the numbers: the runner
  // reads each sequence out to the scan distance and the widest template, in
  // `bandFor`'s strips, and holds that band as `Float32`. This line used to price
  // the square around it — one read and `n²` cells a sequence, 6 GB for mouse
  // chr1 at 5 kb, where the band is 65 MB in ninety-odd reads.
  return {
    class: 'scan',
    requests: strips * (params.balance === true ? 5 : 4),
    bytes: cells * 4,
    note:
      `${scanned.toLocaleString()} ${scanned === 1 ? 'sequence' : 'sequences'}, ` +
      `${scanned === 1 ? '' : 'each '}read as a band along its diagonal — ` +
      `up to ${((cells * 4) / 1e6).toFixed(0)} MB at a time — then a ` +
      `${size}×${size} template correlated across ${band.toLocaleString()} ` +
      `${band === 1 ? 'diagonal' : 'diagonals'} of every ` +
      `bin: about ${formatOperations(operations)} multiply-accumulates` +
      `${passes > 1 ? ` over ${passes} passes` : ''}. ` +
      `${skipped > 0 ? `${skipped.toLocaleString()} sequence${skipped === 1 ? '' : 's'} past the size limit will be skipped.` : ''}`,
  }
}

function formatOperations(count: number): string {
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)} billion`
  if (count >= 1e6) return `${(count / 1e6).toFixed(0)} million`
  return count.toLocaleString()
}

/**
 * Runnable wherever there is a matrix with more bins than the template is wide.
 *
 * The second half is not pedantry: `pattern_detector` returns nothing at all
 * when `min(matrix.shape) <= max(kernel.shape)`, so on a file whose sequences
 * are all shorter than seventeen bins this task can only ever report zero, and
 * saying which is better than reporting it.
 */
function availability(context: AnalysisContext): TaskAvailability {
  if (!context.hasMap) return waitingFor(NEEDS_MAP)
  const smallest = Math.min(...CHROMOSIGHT_PRESETS.map((preset) => preset.sizes[0]))
  const longest = context.contigs.reduce((most, contig) => Math.max(most, contig.bins), 0)
  if (longest <= smallest) {
    return waitingFor(
      `No sequence in this file is longer than the smallest template (${smallest} bins). ` +
        'Open it at a finer resolution.',
    )
  }
  return READY
}

export const CHROMOSIGHT_TASK: AnalysisTask = {
  id: 'chromosight',
  title: 'Pattern detection',
  blurb: 'Find loops, borders, hairpins, centromeres or stripes by template matching (chromosight).',
  group: '2d',
  venue: 'analysis',
  version: 1,
  availability,
  params: PARAMS,
  outputs: ['intervals', 'matrix', 'curve', 'table'],
  estimate,
}
