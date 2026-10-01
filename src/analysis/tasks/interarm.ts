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
 * It is read off the ordinary observed/expected — the distance decay alone,
 * which is exactly what makes the secondary diagonal stand out — as the mean
 * ratio within `band` bins of the secondary diagonal (`analysis/arms.ts`), and
 * given three ways: a **curve** against distance from the origin, the figure the
 * literature draws; a **track** along the chromosome, how much each locus
 * touches its mirror image; and a **table** of two numbers per sequence for a
 * comparison across maps — how far from the origin the enrichment holds before
 * falling nine-tenths of the way back from its peak, and how strong it is from the origin out
 * to there, as a fold over expected.
 *
 * Each sequence has a **second row** of the same numbers over the O/E along both
 * arms — the expectation the map's arms and Compartments divide by, which takes
 * the secondary diagonal into itself. It is a control on that detrending rather
 * than a second measure: where the detrending works, its enrichment is near 1.
 *
 * The arms are read from each sequence's origin — the Origin and terminus task
 * fills it in, a reader types it, and it is the first base until either has —
 * and round the circle where the sequence is declared circular (§8.15).
 */

import { tickedContigs } from '../context'
import type { AnalysisContext, AnalysisTask, CostEstimate, Params, ParamSpec } from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { MAX_CORRELATION_BINS } from './compartments'
import { BALANCE_PARAM } from './shared'

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
  {
    kind: 'number',
    key: 'armWindow',
    label: 'window along the arms',
    unit: 'bins',
    hint:
      'For the detrended row: each cell is compared within this far along the arms, as the map’s ' +
      'arms and Compartments do; 0 is the whole chromosome.',
    // The key, the label and the default are Compartments' own, and the map's
    // arms control opens at the same window (`DEFAULT_ARM_WINDOW`): the row is a
    // control on the detrending they apply, so it is theirs unless changed.
    default: 50,
    min: 0,
    integer: true,
  },
  BALANCE_PARAM,
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
  // 2: a second row per sequence, over the O/E along both arms; and the score is
  // the mean from the origin out to the reach, where it was over the whole arm.
  // 3: the table's score is its enrichment, and it and the peak are folds over
  // expected rather than log2.
  // 4: the reach runs until the enrichment is a tenth of its peak, where it was
  // half, so it reads where the alignment ends rather than the middle of its fall.
  version: 4,
  // A metagenome's MAGs are hundreds of chromosomes whose origins nobody has
  // declared, and the question is asked of one molecule at a time.
  availability: (context) =>
    context.layout === 'metacool' ? { state: 'absent' } : context.hasMap ? READY : waitingFor(NEEDS_MAP),
  params: PARAMS,
  outputs: ['curve', 'profile', 'table'],
  estimate,
}
