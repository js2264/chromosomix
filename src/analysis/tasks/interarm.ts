/**
 * How strongly a bacterial chromosome's two arms are held together, as a
 * descriptor.
 *
 * The secondary diagonal of a bacterial map — contacts between each locus and
 * its mirror image on the other replichore — is the mark SMC leaves when it is
 * loaded at parS near the origin and zips the two arms together as it travels
 * (Wang et al. 2017). It is present in *Bacillus subtilis* and *Caulobacter
 * crescentus*, lost when ParB or SMC is removed, and absent from *Escherichia
 * coli*, whose MukBEF does not align the arms. Comparing species, or a mutant
 * with its wild type, needs it as a number rather than as an impression of a
 * picture, and this task is that number.
 *
 * It is read off **the map as it is drawn** — its score, whether it is divided
 * by an expectation and by which, and the scale it is drawn on — as the mean
 * within `band` bins of the secondary diagonal (`analysis/arms.ts`): balanced
 * O/E on `log2`, the reading that makes the secondary diagonal stand out and the
 * one a shell gets by default, or balanced counts on `log10`, or the O/E along
 * both arms, which divides the secondary diagonal out and leaves what is left of
 * it. The reading is the picture's rather than the form's (`fromView`): a number
 * measured on one reading beside a picture drawn with another is two claims
 * about two different matrices. It is given three ways: a **curve** against
 * distance from the origin, the figure the literature draws; a **track** along
 * the chromosome, how much each locus touches its mirror image; and a **table**
 * of numbers per sequence for a comparison across maps — the mean over the arms,
 * and how far from the origin it holds before falling half-way back.
 *
 * The arms are read from each sequence's origin — the Origin and terminus task
 * fills it in, a reader types it, and it is the first base until either has —
 * and round the circle where the sequence is declared circular (§8.15).
 */

import { tickedContigs } from '../context'
import type { AnalysisContext, AnalysisTask, CostEstimate, Params, ParamSpec } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { MAX_CORRELATION_BINS } from './compartments'

/** What the map is read as: the picture's, unless a shell says otherwise. */
export interface InterArmReading {
  normalise: 'none' | 'vc' | 'vcsqrt' | 'ice'
  /** What the counts are divided by. */
  expected: 'none' | 'decay' | 'arms'
  /** Along the arms, the half-width of the expectation's window, in bins; `0` the whole sequence. */
  window: number
  transform: 'none' | 'log2' | 'log10' | 'log1p'
}

/** The window along the arms where nothing says otherwise: the map's own default. */
const ARMS_WINDOW = 50

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

/** A run's reading, from its parameters — the shell's defaults where one is missing. */
export function interArmReading(params: Params): InterArmReading {
  const window = typeof params.window === 'number' && Number.isFinite(params.window) ? params.window : ARMS_WINDOW
  return {
    normalise: oneOf(params.normalise, ['none', 'vc', 'vcsqrt', 'ice'] as const, 'none'),
    expected: oneOf(params.expected, ['none', 'decay', 'arms'] as const, 'decay'),
    window: Math.max(0, Math.round(window)),
    transform: oneOf(params.transform, ['none', 'log2', 'log10', 'log1p'] as const, 'log2'),
  }
}

const NORMALISATION_WORDS = { none: '', vc: 'VC', vcsqrt: 'VC √', ice: 'ICE' } as const

/** What was averaged, in words: `O/E`, `VC · O/E along the arms, 50 bins`, `contacts`. */
export function readingQuantity(reading: InterArmReading): string {
  const divided =
    reading.expected === 'none'
      ? 'contacts'
      : reading.expected === 'decay'
        ? 'O/E'
        : `O/E along the arms${reading.window > 0 ? `, ${reading.window} bins` : ''}`
  const normalised = NORMALISATION_WORDS[reading.normalise]
  return normalised === '' ? divided : `${normalised} · ${divided}`
}

/** The scale in words: `log2`, `linear`. */
function scaleWords(reading: InterArmReading): string {
  return reading.transform === 'none' ? 'linear' : reading.transform
}

/** The whole reading in words, for the drawer and the labels: `O/E · log2`. */
export function readingWords(reading: InterArmReading): string {
  return `${readingQuantity(reading)} · ${scaleWords(reading)}`
}

/**
 * The track's name: `Inter-arm enrichment · O/E · log2`, and for the counts
 * `Inter-arm contacts · log10` rather than a second `contacts` after the first.
 */
export function readingTitle(reading: InterArmReading): string {
  if (reading.expected !== 'none') return `Inter-arm enrichment · ${readingWords(reading)}`
  const normalised = NORMALISATION_WORDS[reading.normalise]
  return `Inter-arm contacts · ${normalised === '' ? '' : `${normalised} · `}${scaleWords(reading)}`
}

const PARAMS: readonly ParamSpec[] = [
  { kind: 'sequences', key: 'sequences', label: 'sequences' },
  {
    kind: 'number',
    key: 'band',
    label: 'band',
    unit: 'bins',
    hint: 'Cells this close to the secondary diagonal are averaged; 0 is the diagonal alone.',
    default: 2,
    min: 0,
    max: 50,
    integer: true,
  },
  // The picture's reading, never shown (`ChoiceParam.fromView`). The balancing
  // and the column are the framing's already, as for every task, and the
  // runner reads them there — so the view's own, where the file's default
  // would be what the other tasks ask for.
  {
    kind: 'choice',
    key: 'normalise',
    label: 'normalisation',
    default: 'none',
    options: [
      { value: 'none', label: 'none' },
      { value: 'vc', label: 'VC' },
      { value: 'vcsqrt', label: 'VC √' },
      { value: 'ice', label: 'ICE' },
    ],
    fromView: (context) => {
      const normalise = context.framing?.normalise
      return normalise === 'vc' || normalise === 'vcsqrt' || normalise === 'ice' ? normalise : 'none'
    },
  },
  {
    kind: 'choice',
    key: 'expected',
    label: 'divided by',
    default: 'decay',
    options: [
      { value: 'none', label: 'nothing: the contacts themselves' },
      { value: 'decay', label: 'the distance decay' },
      { value: 'arms', label: 'the decay along both arms' },
    ],
    fromView: (context) => context.framing?.reading?.expected,
  },
  {
    kind: 'number',
    key: 'window',
    label: 'window along the arms',
    unit: 'bins',
    default: ARMS_WINDOW,
    min: 0,
    integer: true,
    // Only where the arms are what the picture divides by; elsewhere the value
    // is kept rather than set to the nothing the picture has there.
    fromView: (context) => (context.framing?.reading?.expected === 'arms' ? context.framing.reading.window : undefined),
  },
  {
    kind: 'choice',
    key: 'transform',
    label: 'scale',
    default: 'log2',
    options: [
      { value: 'log2', label: 'log2' },
      { value: 'log10', label: 'log10' },
      { value: 'log1p', label: 'log1p' },
      { value: 'none', label: 'linear' },
    ],
    fromView: (context) => context.framing?.reading?.transform,
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const chosen = tickedContigs(context, params, 'sequences')
  const free = { class: 'free' as const, requests: 0, bytes: 0, note: 'Nothing to read.' }
  if (chosen.length === 0) return { ...free, refusal: 'Tick at least one sequence.' }
  const usable = chosen.filter((contig) => contig.bins <= MAX_CORRELATION_BINS)
  if (usable.length === 0) {
    return {
      ...free,
      refusal:
        `Every ticked sequence is past ${MAX_CORRELATION_BINS.toLocaleString()} bins, and the ` +
        'square is read whole. Open the file at a coarser resolution.',
    }
  }
  const widest = usable.reduce((most, contig) => Math.max(most, contig.bins), 0)
  const bytes = widest * widest * 4
  return {
    class: usable.length > 1 ? 'scan' : 'bounded',
    requests: usable.length * 4,
    bytes,
    note:
      `${usable.length.toLocaleString()} ${usable.length === 1 ? 'square' : 'squares'} read ` +
      `whole, the largest ${widest.toLocaleString()} bins a side`,
  }
}

export const INTERARM_TASK: AnalysisTask = {
  id: 'interarm',
  title: 'Inter-arm alignment',
  blurb: 'How strongly the two arms of a bacterial chromosome touch, from origin to terminus.',
  group: '2d',
  venue: 'analysis',
  // 2: read as the map is drawn — its score, its O/E or none, and its scale —
  // where it was the distance-decay O/E on log2 whatever the picture showed.
  version: 2,
  // A metagenome's MAGs are hundreds of chromosomes whose origins nobody has
  // declared, and the question is asked of one molecule at a time.
  availability: (context) =>
    context.layout === 'metacool' ? { state: 'absent' } : context.hasMap ? READY : waitingFor(NEEDS_MAP),
  params: PARAMS,
  outputs: ['curve', 'profile', 'table'],
  estimate,
  asRead: (params) => readingWords(interArmReading(params)),
}
