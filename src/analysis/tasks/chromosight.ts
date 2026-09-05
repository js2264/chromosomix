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
import { BALANCE_PARAM } from './shared'

/**
 * The largest square this will scan, in bins.
 *
 * The same gate `analysis/tasks/compartments.ts` argues for, at the same figure
 * and for a different reason: there it is an `m²` correlation matrix, here it is
 * an `m²` dense read plus a band of diagonals over it. Yeast chrIV at 1 kb is
 * 1,531 bins; human chr1 at 100 kb is 2,490. A sequence past the limit is
 * skipped and named rather than scanned at a resolution nobody chose.
 */
export const MAX_SCAN_BINS = 8192

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

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'choice',
    key: 'pattern',
    label: 'Pattern',
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
    label: 'Sequences',
    hint: 'Every one, unless you say otherwise. Each is scanned on its own.',
  },
  {
    kind: 'choice',
    key: 'thresholds',
    label: 'Thresholds',
    default: 'preset',
    options: [
      {
        value: 'preset',
        label: 'From the pattern',
        hint: 'chromosight’s own numbers for the template above — what `chromosight detect` uses.',
      },
      {
        value: 'custom',
        label: 'Set them myself',
        hint: 'The boxes start at the loops preset; check them against the pattern you picked.',
      },
    ],
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'pearson',
    label: 'Score threshold',
    hint: 'The correlation a pixel must reach to be a candidate. Lower finds more, and more of it is noise.',
    default: 0.3,
    min: 0,
    max: 1,
    step: 0.01,
    slider: true,
    when: custom,
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'minDist',
    label: 'Nearest to the diagonal',
    default: 20_000,
    min: 0,
    unit: 'bp',
    when: custom,
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'maxDist',
    label: 'Furthest from the diagonal',
    hint: 'The scan band. Widening it costs time in proportion; zero means the pattern is on the diagonal.',
    default: 2_000_000,
    min: 0,
    unit: 'bp',
    when: custom,
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'minSeparation',
    label: 'Nearest two calls may be',
    hint: 'Closer than this on both axes and only the higher-scoring one is kept.',
    default: 5_000,
    min: 0,
    unit: 'bp',
    when: custom,
    section: 'Scan',
  },
  {
    kind: 'number',
    key: 'iterations',
    label: 'Refinement passes',
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
    label: 'Most undetectable pixels a window may hold',
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
    label: 'Most empty pixels a window may hold',
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
    label: 'Detectability cut',
    hint: 'Median absolute deviations below the median coverage. Only used where the file carries no weights.',
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
    label: 'Report down to a q-value of',
    hint: 'Benjamini-Hochberg over every call. 1 keeps them all and still reports the number.',
    default: 1,
    min: 0,
    max: 1,
    step: 0.01,
    slider: true,
    section: 'Quality',
  },
  BALANCE_PARAM,
]

/** The sequences a run will scan, after the ticks and the size gate. */
function chosen(context: AnalysisContext, params: Params): { scanned: number; bins: number; skipped: number } {
  const ticked = Array.isArray(params.sequences)
    ? new Set(params.sequences.filter((name): name is string => typeof name === 'string'))
    : null
  let scanned = 0
  let widest = 0
  let skipped = 0
  for (const contig of context.contigs) {
    if (ticked !== null && !ticked.has(contig.name)) continue
    if (contig.bins > MAX_SCAN_BINS) {
      skipped++
      continue
    }
    scanned++
    widest = Math.max(widest, contig.bins)
  }
  return { scanned, bins: widest, skipped }
}

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const preset = presetFor(params)
  const { scanned, bins, skipped } = chosen(context, params)
  if (scanned === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        skipped > 0
          ? `Every chosen sequence is past the ${MAX_SCAN_BINS.toLocaleString()}-bin limit on a ` +
            'scan. Open the file at a coarser resolution, or choose a shorter sequence.'
          : 'Tick at least one sequence.',
    }
  }

  const binsize = context.binsize > 0 ? context.binsize : 1
  const maxDist = threshold(params, 'maxDist', preset.maxDist)
  const band = Math.max(1, Math.min(Math.floor(maxDist / binsize) || 1, bins))
  const size = preset.sizes[0]
  const iterations =
    typeof params.iterations === 'number' && Number.isFinite(params.iterations)
      ? Math.max(1, Math.round(params.iterations))
      : 1
  const passes = preset.sizes.length * iterations
  // Multiply-accumulates, not bytes, because this is the number that decides
  // whether the run is worth starting: the read is one square per sequence and
  // is over in a moment, and then every pixel of the band is correlated against
  // `size²` template cells. Stating the bytes alone would price the cheap half.
  const operations = scanned * bins * band * size * size * passes

  return {
    class: 'scan',
    requests: scanned * (params.balance === true ? 5 : 4),
    bytes: bins * bins * 4,
    note:
      `${scanned.toLocaleString()} ${scanned === 1 ? 'sequence' : 'sequences'}, one dense square ` +
      `each — up to ${((bins * bins * 4) / 1e6).toFixed(0)} MB at a time — then a ` +
      `${size}×${size} template correlated across ${band.toLocaleString()} diagonals of every ` +
      `bin: about ${formatOperations(operations)} multiply-accumulates` +
      `${passes > 1 ? ` over ${passes} passes` : ''}. ` +
      `${skipped > 0 ? `${skipped.toLocaleString()} sequence${skipped === 1 ? '' : 's'} past the size limit will be skipped. ` : ''}` +
      'Progress is reported per sequence and it can be cancelled at any point.',
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
  group: 'map',
  venue: 'analysis',
  version: 1,
  availability,
  params: PARAMS,
  outputs: ['intervals', 'matrix', 'curve', 'table'],
  estimate,
}
