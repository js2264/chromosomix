/**
 * Compartments, as a descriptor — and the one task in the catalogue that
 * refuses on size.
 *
 * The correlation matrix is `m²` in the bins of one sequence, and unlike every
 * other object in this subtree it is not bounded by the picture: a whole yeast
 * genome at 1 kb is 12,100 bins and a 586 MB matrix, and human chr1 at 10 kb is
 * 24,900 bins and 2.5 GB. So this task has a **bin-count gate** (§18.6), written
 * in `checkDenseSize`'s voice — naming the count, the bytes and the way out —
 * rather than quietly coarsening to something that fits and reporting the
 * answer to a different question.
 *
 * It is also the one task that is **absent on a metacool**, and not for a
 * technical reason. Compartments are a property of a large eukaryotic
 * chromosome; a bacterial MAG has domains and does not have compartments, and
 * offering the row would invite a reader to compute an eigenvector of a thing
 * that has none. `analysis/tasks/cid.ts` is the domain concept that does apply
 * there, and it is offered on both.
 *
 * **Phasing is a dropdown over what is already loaded**, defaulting to the
 * starred entry. This is the step that usually needs a second tool, and here
 * both signals a reader would reach for — a gene model and a FASTA's GC content
 * — are already in the session.
 */

import type {
  AnalysisContext,
  AnalysisTask,
  ContextContig,
  CostEstimate,
  ParamSpec,
  Params,
} from '../types'
import { NEEDS_MAP, READY, waitingFor } from '../types'
import { BALANCE_PARAM } from './shared'

/**
 * The largest correlation matrix this will build.
 *
 * `m²` doubles at 8 bytes a cell, so 8,192 bins is 512 MB — past what a tab
 * should allocate for one intermediate, and comfortably past every sequence a
 * reader looks at compartments on. Yeast chrIV at 1 kb is 1,531 bins and 19 MB;
 * human chr1 at 100 kb is 2,490 and 50 MB.
 */
export const MAX_CORRELATION_BINS = 8192

/** The ticked sequence names. `[]` is a state the reader can reach — see below. */
function tickedNames(params: Params): string[] {
  const value = params.sequences
  return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : []
}

/** The ticked sequences, as rows of the contigs table. */
function ticked(context: AnalysisContext, params: Params): ContextContig[] {
  const names = new Set(tickedNames(params))
  return context.contigs.filter((contig) => names.has(contig.name))
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'Sequences',
    /**
     * **Several**, and every one of them ticked to begin with.
     *
     * It used to be a single picker, and before that a refusal — *name a
     * sequence* — on the argument that compartments are a property of one
     * chromosome. That argument is about the *expectation*, which really is per
     * chromosome and stays per chromosome (`ExpectedPlan`), and it does not carry
     * to the correlation: two chromosomes in the same compartment touch each
     * other **in trans**, and a square holding those trans blocks is where a
     * genome-wide eigenvector's signal actually comes from. Ticking them all is
     * therefore not sixteen runs stacked up — it is one answer the per-sequence
     * runs cannot give.
     *
     * Everything ticked is the default because it is the question most people
     * are asking, and because the alternative default — one arbitrary sequence —
     * is a run whose scope the reader did not choose. **None** and **All** are
     * beside the list, since the two states worth reaching quickly are all of
     * them and one of them.
     */
    hint: 'One correlation over all of them, cis and trans. Ticking one gives that chromosome alone.',
  },
  {
    kind: 'number',
    key: 'components',
    label: 'Components',
    hint: 'E1 is the compartment track; E2 and E3 occasionally say something.',
    default: 1,
    min: 1,
    max: 3,
    integer: true,
    slider: true,
  },
  {
    kind: 'featureSet',
    key: 'phaseFeatures',
    label: 'Phase by gene density',
    optional: true,
    noneLabel: 'Do not use a gene model',
    hint: 'Positive is made to mean the compartment these features are dense in.',
    section: 'Phasing',
  },
  {
    kind: 'sequence',
    key: 'phaseSequence',
    label: 'Phase by GC content',
    optional: true,
    noneLabel: 'Do not use a sequence',
    hint: 'Used when no gene model is chosen.',
    section: 'Phasing',
  },
  {
    kind: 'number',
    key: 'minR',
    label: 'Least convincing correlation',
    hint: 'Below this the sign is left alone and the drawer says the phasing was ambiguous.',
    default: 0.1,
    min: 0,
    max: 1,
    step: 0.05,
    slider: true,
    section: 'Phasing',
  },
  {
    kind: 'toggle',
    key: 'saddle',
    label: 'Also draw the saddle',
    hint: 'The compartment claim in one square, with AA, BB and AB under it.',
    default: true,
    section: 'Saddle',
  },
  {
    kind: 'number',
    key: 'quantiles',
    label: 'Quantile groups',
    default: 50,
    min: 5,
    max: 100,
    integer: true,
    when: (params) => params.saddle !== false,
    section: 'Saddle',
  },
  BALANCE_PARAM,
]

/**
 * How many dense reads a set of ticked sequences costs.
 *
 * The **coalesced runs**, squared and halved: adjacent ticked sequences are one
 * run and read as one rectangle, so everything ticked is a single read of the
 * whole file rather than 136 of them. A scattered subset pays a rectangle per
 * pair of runs, which is the honest price of not reading the gaps between them.
 */
function readsFor(context: AnalysisContext, chosen: readonly ContextContig[]): number {
  const ticked = new Set(chosen.map((contig) => contig.name))
  let runs = 0
  let inRun = false
  for (const contig of context.contigs) {
    const on = ticked.has(contig.name)
    if (on && !inRun) runs++
    inRun = on
  }
  return (runs * (runs + 1)) / 2
}

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const chosen = ticked(context, params)
  if (chosen.length === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        tickedNames(params).length === 0
          ? 'Tick at least one sequence. All of them is the genome-wide compartment call.'
          : 'None of the ticked sequences is in this file.',
    }
  }

  const bins = chosen.reduce((total, contig) => total + contig.bins, 0)
  const bytes = bins * bins * 8
  if (bins > MAX_CORRELATION_BINS) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        `Refusing to build a ${bins.toLocaleString()}×${bins.toLocaleString()} correlation ` +
        `matrix (${(bytes / 1e9).toFixed(1)} GB) over ${chosen.length.toLocaleString()} ticked ` +
        `${chosen.length === 1 ? 'sequence' : 'sequences'}. The limit is ` +
        `${MAX_CORRELATION_BINS.toLocaleString()} bins a side — untick some, or open the file at ` +
        'a coarser resolution.',
    }
  }

  const balance = params.balance === true
  const framing = context.framing
  const spanned: [number, number] = [
    Math.min(...chosen.map((contig) => contig.startBin)),
    Math.max(...chosen.map((contig) => contig.startBin + contig.bins)),
  ]
  const free =
    context.blockLoaded &&
    framing !== null &&
    framing.binsPerCell === 1 &&
    framing.balance === balance &&
    framing.rows[0] <= spanned[0] &&
    framing.rows[1] >= spanned[1] &&
    framing.cols[0] <= spanned[0] &&
    framing.cols[1] >= spanned[1]

  // The correlation is `m²` doubles and `m³` operations, and it is the second
  // number that decides whether a run is worth starting: at a thousand bins it
  // is a second and at four thousand it is minutes. Both are stated, because a
  // reader who sees only the megabytes will tick everything at a fine
  // resolution and conclude the app has hung.
  const note =
    `A ${bins.toLocaleString()} bin correlation matrix over ` +
    `${chosen.length.toLocaleString()} ${chosen.length === 1 ? 'sequence' : 'sequences'}, cis and ` +
    `trans — ${(bytes / 1e6).toFixed(0)} MB held while it is solved, and the correlation itself ` +
    'grows as the cube of the bin count.'
  if (free) {
    return { class: 'free', requests: 0, bytes, note: `${note} Read from the block on screen.` }
  }
  const reads = readsFor(context, chosen)
  return {
    class: reads > 1 ? 'scan' : 'bounded',
    requests: reads * (balance ? 5 : 4),
    bytes,
    note:
      `${note} ${reads.toLocaleString()} dense ${reads === 1 ? 'read' : 'reads'} to build it ` +
      'from. Progress is reported as it goes and it can be cancelled at any point.',
  }
}

export const COMPARTMENTS_TASK: AnalysisTask = {
  id: 'compartments',
  title: 'Compartments (eigenvectors)',
  blurb: 'Observed/expected, correlated, and its leading components.',
  group: 'map',
  venue: 'analysis',
  version: 1,
  // Absent on a metacool, which is a scientific judgement rather than a
  // technical one: a bacterial MAG has domains and no compartments, and a row
  // offering an eigenvector of a thing that has none is an invitation to
  // over-read a picture. See the module docstring.
  // Absent on a metacool and *waiting* with no map: the first is a decision
  // about what a compartment means on a metagenome (§18.9) and no file the
  // reader opens next changes it; the second is one drag away from ready.
  availability: (context) =>
    context.layout === 'metacool'
      ? { state: 'absent' }
      : context.hasMap
        ? READY
        : waitingFor(NEEDS_MAP),
  params: PARAMS,
  outputs: ['profile', 'intervals', 'matrix'],
  estimate,
}
