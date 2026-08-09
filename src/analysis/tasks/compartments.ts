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

import { contigNamed } from '../context'
import type {
  AnalysisContext,
  AnalysisTask,
  ContextContig,
  CostEstimate,
  ParamSpec,
  Params,
} from '../types'

/**
 * The largest correlation matrix this will build.
 *
 * `m²` doubles at 8 bytes a cell, so 8,192 bins is 512 MB — past what a tab
 * should allocate for one intermediate, and comfortably past every sequence a
 * reader looks at compartments on. Yeast chrIV at 1 kb is 1,531 bins and 19 MB;
 * human chr1 at 100 kb is 2,490 and 50 MB.
 */
export const MAX_CORRELATION_BINS = 8192

function regionOf(params: Params): string {
  return typeof params.region === 'string' ? params.region.trim() : ''
}

function regionContig(context: AnalysisContext, region: string): ContextContig | undefined {
  const name = region.split(':')[0].trim()
  return name === '' ? undefined : contigNamed(context, name)
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'region',
    key: 'region',
    label: 'Sequence',
    sequences: true,
    required: true,
    hint: 'One sequence at a time. Compartments are a property of a chromosome.',
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
  {
    kind: 'toggle',
    key: 'balance',
    label: 'Use balancing weights',
    hint: 'Strongly advised: an unbalanced correlation matrix is mostly a picture of coverage.',
    default: true,
    section: 'Quality',
  },
  {
    kind: 'number',
    key: 'minCoverage',
    label: 'Least usable row',
    hint: 'A bin with fewer finite cells than this fraction takes no part.',
    default: 0.1,
    min: 0,
    max: 1,
    step: 0.05,
    slider: true,
    section: 'Quality',
  },
]

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const contig = regionContig(context, regionOf(params))
  if (contig === undefined) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        regionOf(params) === ''
          ? 'Name a sequence. A correlation matrix is per chromosome — see the note on cost.'
          : `This file has no sequence called ${regionOf(params).split(':')[0].trim()}.`,
    }
  }

  const bytes = contig.bins * contig.bins * 8
  if (contig.bins > MAX_CORRELATION_BINS) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        `Refusing to build a ${contig.bins.toLocaleString()}×${contig.bins.toLocaleString()} ` +
        `correlation matrix (${(bytes / 1e9).toFixed(1)} GB) for ${contig.name}. ` +
        `The limit is ${MAX_CORRELATION_BINS.toLocaleString()} bins a side. Open the file at a ` +
        'coarser resolution, or choose a shorter sequence.',
    }
  }

  const balance = params.balance !== false
  const framing = context.framing
  const extent: [number, number] = [contig.startBin, contig.startBin + contig.bins]
  const free =
    context.blockLoaded &&
    framing !== null &&
    framing.binsPerCell === 1 &&
    framing.balance === balance &&
    framing.rows[0] <= extent[0] &&
    framing.rows[1] >= extent[1] &&
    framing.cols[0] <= extent[0] &&
    framing.cols[1] >= extent[1]

  const note =
    `A ${contig.bins.toLocaleString()} bin correlation matrix — ` +
    `${(bytes / 1e6).toFixed(0)} MB held while it is solved.`
  return free
    ? { class: 'free', requests: 0, bytes, note: `${note} Read from the block on screen.` }
    : {
        class: 'bounded',
        requests: balance ? 5 : 4,
        bytes,
        note: `${note} One dense square to read it from.`,
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
  appliesTo: (context) => context.nBins > 0 && context.layout !== 'metacool',
  params: PARAMS,
  outputs: ['profile', 'matrix'],
  estimate,
}
