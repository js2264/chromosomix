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
 * that has none. insulation and the domains it calls between its boundaries are the domain concept that does apply
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
import { tickedContigs } from '../context'
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

/**
 * Past this many bins a sequence the run is *allowed* and not sensible.
 *
 * Compartments are called at 250 kb on a mammalian genome, which is under a
 * thousand bins for its longest chromosome; 100 kb — about two thousand — is
 * the fine end of what the literature uses, and correlates in under half a
 * second here. The correlation grows as the cube of the bin count, so the 4,642
 * bins of *E. coli* at 1 kb are four seconds on one core and the gate's 8,192
 * are twenty — the matrix product and the cores (`pearsonThreads.ts`) have made
 * a finer run a wait rather than the six minutes it was, and not a sensible one.
 * The gate above still decides what runs; this only decides what is said beside
 * Run.
 */
export const COMFORTABLE_CORRELATION_BINS = 2000

/** Which contacts enter the correlation; see the `contacts` parameter. */
function contactsOf(params: Params): 'cis' | 'trans' | 'both' {
  const value = params.contacts
  // An unrecognised value falls back to the default rather than to the widest
  // reading: a stored session written by a later build can name a mode this one
  // has never heard of, and the honest answer is the cheap per-chromosome run
  // rather than a genome-wide correlation nobody asked for.
  return value === 'trans' || value === 'both' ? value : 'cis'
}

/**
 * The ticked sequence names, or `null` for a run that was never asked.
 *
 * `[]` and `null` are two answers and this used to collapse them into one:
 * anything that was not an array read as *nothing ticked*, which is right for
 * the form — it ticks every box on the way in, so `[]` there is a reader who
 * pressed **none** — and wrong for everything that does not go through a form.
 * `chromosomix compartments file.cool` with no `--sequences` refused itself,
 * naming a control the shell has not got, and the README's own example did it.
 * Unanswered is every sequence (§18.2), which is the genome-wide call this task
 * exists for.
 */
function tickedNames(params: Params): string[] | null {
  const value = params.sequences
  if (Array.isArray(value)) {
    return value.filter((name): name is string => typeof name === 'string')
  }
  return typeof value === 'string' && value.trim() !== '' ? [value.trim()] : null
}

/** The ticked sequences, as rows of the contigs table. */
function ticked(context: AnalysisContext, params: Params): ContextContig[] {
  return tickedContigs(context, params, 'sequences')
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
    /**
     * **Several**, and every one of them ticked to begin with.
     *
     * It used to be a single picker, and before that a refusal — *name a
     * sequence* — on the argument that compartments are a property of one
     * chromosome. That argument is about the *expectation*, which really is per
     * chromosome and stays per chromosome (`ExpectedPlan`), and it does not carry
     * to the correlation: two chromosomes in the same compartment touch each
     * other **in trans**, and a square holding those trans blocks is where a
     * genome-wide eigenvector's signal actually comes from. Under *cis and
     * trans* or *trans only*, ticking them all is therefore not sixteen runs
     * stacked up — it is one answer the per-sequence runs cannot give. Under
     * *cis only*, the default (see `contacts`), it is the sixteen: one
     * correlation per sequence. The hint says which of the two the reader is
     * about to get; it used to promise the one correlation under the setting
     * that never makes it.
     *
     * Everything ticked is the default because it is the question most people
     * are asking, and because the alternative default — one arbitrary sequence —
     * is a run whose scope the reader did not choose. **None** and **All** are
     * beside the list, since the two states worth reaching quickly are all of
     * them and one of them.
     */
    hint:
      'One correlation per sequence under “cis only”, and one over all of them under “cis and ' +
      'trans” or “trans only”.',
  },
  {
    kind: 'choice',
    key: 'contacts',
    label: 'contacts',
    /**
     * **Cis by default**, and the reason is what a default is for: the answer
     * most readers want, at a price most files can pay. A per-chromosome
     * eigenvector is the object people mean by "the compartment track", it is
     * what every other tool produces without being asked, and it is the only one
     * of the three that runs at a fine resolution — the correlation is cubic, so
     * sixteen squares of 1,500 bins is a fraction of one of 24,000. A reader who
     * wants the genome-wide call is asking a further question and can say so.
     */
    default: 'cis',
    /**
     * Three genuinely different computations, not a filter over one.
     *
     * **Trans** is the standard genome-wide call and is the one worth
     * explaining: the cis blocks carry a near-diagonal that dominates every row,
     * and dividing it out by an expected curve is a correction rather than an
     * absence — so a correlation with them left out is a statement about which
     * sequences share a nuclear compartment and nothing else.
     *
     * **Cis** is the per-chromosome eigenvector, and choosing it changes the
     * *shape* of the run rather than only its input: it is one correlation per
     * sequence rather than one across them, because a single square with its
     * trans blocks removed correlates to a block-diagonal matrix whose leading
     * eigenvector lives on one chromosome and is zero on the rest. That also
     * makes it far the cheapest of the three — the correlation is cubic, so
     * sixteen squares of 1,500 bins is a fraction of one of 24,000 — which is
     * what lets it run at a fine resolution where the other two cannot.
     */
    options: [
      {
        value: 'cis',
        label: 'cis only',
        hint: 'One correlation per sequence, over its own contacts. The cheapest, and per chromosome.',
      },
      {
        value: 'both',
        label: 'cis and trans',
        hint: 'One correlation over everything ticked. Each half keeps its own expectation.',
      },
      {
        value: 'trans',
        label: 'trans only',
        hint: 'Between sequences alone, so no distance decay enters the answer. Needs two or more.',
      },
    ],
  },
  {
    kind: 'number',
    key: 'ignoreDiags',
    label: 'diagonals to ignore',
    /**
     * cooltools' `ignore_diags`, spelled the same way and meaning the same
     * thing: `0` keeps every cell, `1` drops the main diagonal, `2` drops it and
     * the two beside it — `|col − row| < n`.
     *
     * **Two by default**, which is cooltools' default and is not a round number
     * picked for tidiness. The near-diagonal is where self-ligation and
     * unligated fragments end up; those cells are the largest in the matrix and
     * the least structural, and a row's correlation with its neighbours is
     * carried disproportionately by the two or three of them nearest the
     * diagonal — which say only that the bins are adjacent. Every chromosome's
     * rows agree about that, so left in it enters the eigenvector as a component
     * that is really a picture of the diagonal.
     *
     * Hidden under *trans only*, where there is no diagonal to ignore.
     */
    hint: '0 keeps every cell; 1 drops the main diagonal; 2 drops it and the two beside it.',
    default: 2,
    min: 0,
    integer: true,
    when: (params) => params.contacts !== 'trans',
  },
  {
    kind: 'choice',
    key: 'expected',
    label: 'expected',
    /**
     * What each cell is divided by before the correlation — **the distance
     * decay by default**, which is every other tool's answer and the right one
     * for a chromosome with one diagonal.
     *
     * A bacterial chromosome whose arms are held together has two: the ordinary
     * one and a secondary diagonal through the origin. The decay curve averages
     * each diagonal of the map and every one of them crosses the secondary
     * diagonal, so the ratio is left with an X that the correlation then draws
     * and the eigenvectors follow — the arms, and not the compartments.
     * *Decay along both arms* is the expectation that removes both
     * (`analysis/arms.ts`), read from the origin declared for the sequence —
     * the one the Chromosomes table shows. Cis only, because the arms are a
     * fact about one sequence.
     */
    default: 'distance',
    options: [
      {
        value: 'distance',
        label: 'distance decay',
        hint: 'The mean of each diagonal: the ordinary observed/expected.',
      },
      {
        value: 'arms',
        label: 'decay along both arms',
        hint:
          'Also removes the secondary diagonal of a bacterial chromosome whose arms are aligned, ' +
          'reading the arms from the origin on the Chromosomes table — the first base unless set.',
      },
    ],
    when: (params) => contactsOf(params) === 'cis',
  },
  {
    kind: 'number',
    key: 'armWindow',
    label: 'window along the arms',
    unit: 'bins',
    hint: 'Each cell is compared within this far along the arms; 0 is the whole chromosome.',
    default: 50,
    min: 0,
    integer: true,
    when: (params) => contactsOf(params) === 'cis' && params.expected === 'arms',
  },
  {
    kind: 'choice',
    key: 'method',
    label: 'method',
    /**
     * What the eigenvectors are taken of — **cooltools' way by default**
     * (`eigs_cis`): observed/expected itself, clipped at its 99.9th percentile,
     * less one so the matrix is each cell's departure from expected, and every
     * gap read as expected (`cooltoolsMatrix`). What the field computes today,
     * and a track made this way compares with one cooltools wrote, on its scale,
     * √|λ| — |r| = 1.000 with `eigs_cis` on the zoo's maps, the rest being
     * cooltools' expectation (SPECS §18.8). It skips the correlation, the one
     * cubic step, so a fine map takes seconds.
     *
     * The other is the correlation of the rows, as Lieberman-Aiden et al. (2009)
     * did it. The two agree where a chromosome has compartments to find and part
     * where it has none, which is itself worth seeing.
     */
    default: 'cooltools',
    options: [
      {
        value: 'cooltools',
        label: 'cooltools',
        hint: 'Observed/expected itself, clipped at its 99.9th percentile and less one, decomposed.',
      },
      {
        value: 'correlation',
        label: 'Lieberman-Aiden 2009',
        hint: 'The Pearson correlation of observed/expected’s rows, decomposed.',
      },
    ],
  },
  {
    kind: 'number',
    key: 'components',
    label: 'components',
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
    label: 'phase by gene density',
    optional: true,
    noneLabel: 'Do not use a gene model',
    hint: 'Positive is made to mean the compartment these features are dense in.',
    section: 'Phasing',
  },
  {
    kind: 'track',
    key: 'phaseTrack',
    label: 'phase by a track',
    optional: true,
    noneLabel: 'Do not use a track',
    // Chosen, never assumed: filled from the first bigWig, it would phase every
    // map with a ChIP track loaded by that track rather than by GC content.
    startsEmpty: true,
    hint: 'Positive is made to follow this track, when no gene model is chosen.',
    section: 'Phasing',
  },
  {
    kind: 'sequence',
    key: 'phaseSequence',
    label: 'phase by GC content',
    optional: true,
    noneLabel: 'Do not use a sequence',
    hint: 'Used when neither a gene model nor a track is chosen.',
    section: 'Phasing',
  },
  {
    kind: 'number',
    key: 'minR',
    label: 'least convincing correlation',
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
    label: 'draw the saddle',
    hint: 'The compartment claim in one square, with AA, BB and AB under it.',
    default: true,
    section: 'Saddle',
  },
  {
    kind: 'number',
    key: 'quantiles',
    label: 'quantile groups',
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

/**
 * Cis-only: one correlation per sequence, priced as such.
 *
 * The numbers that change are the two that matter. The **bytes** are the largest
 * sequence's matrix rather than the whole set's, because the squares are built
 * and released one after another — quoting the total would quote a peak that
 * never happens. And the **gate** applies per sequence, which is the whole
 * practical difference between the modes: a yeast genome is 12,100 bins at 1 kb
 * and refused as one correlation, while the same sixteen chromosomes correlated
 * separately are 1,500 bins each and entirely ordinary.
 */
/**
 * The warning beside Run when the resolution is finer than compartments want.
 *
 * `''` under {@link COMFORTABLE_CORRELATION_BINS}. Otherwise one sentence
 * that says why, and the rung of this file — finest first — at which the
 * widest sequence would fit, so the reader has somewhere to go rather than
 * an adjective.
 */
function tooFineNote(
  context: AnalysisContext,
  bins: number,
  length: number,
  unit: 'a sequence' | 'in all',
): string {
  if (bins <= COMFORTABLE_CORRELATION_BINS) return ''
  const rung = (context.resolutions ?? []).find(
    (binsize) => binsize > context.binsize && Math.ceil(length / binsize) <= COMFORTABLE_CORRELATION_BINS,
  )
  const advice =
    rung === undefined
      ? 'Open the file at a coarser resolution.'
      : `Open it at ${fmtBp(rung)} (${Math.ceil(length / rung).toLocaleString()} bins) or coarser.`
  return (
    `${bins.toLocaleString()} bins ${unit} at ${fmtBp(context.binsize)} is far finer than ` +
    'compartments need — 250 kb is the usual bin on a mammalian genome, and past about ' +
    `${COMFORTABLE_CORRELATION_BINS.toLocaleString()} bins the correlation's wait grows as the cube ` +
    `of the bins. ${advice} `
  )
}

/** `1 kb`, `250 kb`, `1 Mb`, `500 bp`. Local, so this module imports nothing from the UI. */
function fmtBp(bp: number): string {
  if (bp >= 1e6 && bp % 1e5 === 0) return `${bp / 1e6} Mb`
  if (bp >= 1e3 && bp % 100 === 0) return `${bp / 1e3} kb`
  return `${bp.toLocaleString()} bp`
}

function estimateCis(
  context: AnalysisContext,
  chosen: readonly ContextContig[],
  balance: boolean,
  cooltools: boolean,
): CostEstimate {
  const usable = chosen.filter((contig) => contig.bins <= MAX_CORRELATION_BINS)
  const skipped = chosen.length - usable.length
  if (usable.length === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        `Every ticked sequence is past the ${MAX_CORRELATION_BINS.toLocaleString()}-bin limit on ` +
        `${cooltools ? 'the matrix it decomposes' : 'a correlation matrix'}. Open the file at a ` +
        'coarser resolution.',
    }
  }
  const widestContig = usable.reduce<ContextContig | undefined>(
    (most, contig) => (most === undefined || contig.bins > most.bins ? contig : most),
    undefined,
  )
  const widest = widestContig?.bins ?? 0
  const bytes = widest * widest * 8
  const tooFine = cooltools ? '' : tooFineNote(context, widest, widestContig?.length ?? 0, 'a sequence')
  return {
    // A run finer than it should be is coloured as a scan is, whatever its
    // request count: the colour is the one warning a reader sees before Run.
    class: usable.length > 1 || tooFine !== '' ? 'scan' : 'bounded',
    requests: usable.length * (balance ? 5 : 4),
    bytes,
    note:
      tooFine +
      `${usable.length.toLocaleString()} ${usable.length === 1 ? 'sequence' : 'sequences'}, one ` +
      `${cooltools ? 'decomposition' : 'correlation'} each — up to ${(bytes / 1e6).toFixed(0)} MB ` +
      `held at once, over at most ${widest.toLocaleString()} bins. ` +
      `${skipped > 0 ? `${skipped.toLocaleString()} too large to ${cooltools ? 'decompose' : 'correlate'} and skipped.` : ''}`,
  }
}

function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const chosen = ticked(context, params)
  const contacts = contactsOf(params)
  if (chosen.length === 0) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        (tickedNames(params) ?? []).length === 0
          ? 'Tick at least one sequence. All of them is the genome-wide compartment call.'
          : 'None of the ticked sequences is in this file.',
    }
  }
  if (contacts === 'trans' && chosen.length < 2) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        'A trans correlation is between sequences, so it needs at least two ticked. Tick more, ' +
        'or read this one’s cis contacts instead.',
    }
  }

  const balance = params.balance === true
  // **The correlation's cost is the correlation's.** cooltools' road skips it and
  // pays for the eigenvectors alone, each a few hundred passes over the square:
  // eight seconds for three of them over the 4,642 bins of *E. coli* at 1 kb,
  // where the correlation adds its own cube. So the warning about a resolution
  // too fine, which is a warning about that cube, is the correlation's to give.
  // Absent is the default, which is cooltools'.
  const cooltools = params.method !== 'correlation'
  // Cis-only is a different shape of run, not a narrower one — see `estimateCis`
  // and the `contacts` parameter.
  if (contacts === 'cis') return estimateCis(context, chosen, balance, cooltools)

  const bins = chosen.reduce((total, contig) => total + contig.bins, 0)
  const bytes = bins * bins * 8
  if (bins > MAX_CORRELATION_BINS) {
    return {
      class: 'free',
      requests: 0,
      bytes: 0,
      note: 'Nothing to read.',
      refusal:
        `Refusing to build a ${bins.toLocaleString()}×${bins.toLocaleString()} ` +
        `${cooltools ? '' : 'correlation '}matrix (${(bytes / 1e9).toFixed(1)} GB) over ` +
        `${chosen.length.toLocaleString()} ticked ` +
        `${chosen.length === 1 ? 'sequence' : 'sequences'}. The limit is ` +
        `${MAX_CORRELATION_BINS.toLocaleString()} bins a side — untick some, open the file at a ` +
        `coarser resolution, or read the cis contacts alone, which ${cooltools ? 'decomposes' : 'correlates'} ` +
        'each sequence on its own.',
    }
  }

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
    `A ${bins.toLocaleString()} bin ${cooltools ? 'observed/expected' : 'correlation'} matrix over ` +
    `${chosen.length.toLocaleString()} ${chosen.length === 1 ? 'sequence' : 'sequences'}, ` +
    `${contacts === 'trans' ? 'trans only' : 'cis and trans'} — ${(bytes / 1e6).toFixed(0)} MB ` +
    `held while it is solved${cooltools ? '.' : ', and the correlation itself grows as the cube of the bin count.'}`
  if (free) {
    return { class: 'free', requests: 0, bytes, note: `${note} Read from the block on screen.` }
  }
  const reads = readsFor(context, chosen)
  const tooFine = cooltools
    ? ''
    : tooFineNote(
        context,
        bins,
        chosen.reduce((total, contig) => total + contig.length, 0),
        'in all',
      )
  return {
    class: reads > 1 || tooFine !== '' ? 'scan' : 'bounded',
    requests: reads * (balance ? 5 : 4),
    bytes,
    note:
      `${tooFine}${note} ${reads.toLocaleString()} dense ${reads === 1 ? 'read' : 'reads'} to build ` +
      'it from.',
  }
}

export const COMPARTMENTS_TASK: AnalysisTask = {
  id: 'compartments',
  title: 'Compartments',
  blurb: 'Observed/expected, correlated or taken as it is, and its leading components.',
  group: '2d',
  venue: 'analysis',
  // 2: a sequence declared circular is divided by its own decay measured the
  // short way round (§8.15), where it used to be measured along a line — which
  // changes every number the task produces on one.
  // 3: the components are ranked by their eigenvalues alone — the phasing signal
  // signs each and no longer chooses among them — the components table gives
  // each one's eigenvalue, and its r with the signal as it is drawn, and what is
  // decomposed is a choice: observed/expected as cooltools prepares it by
  // default, where every earlier version took the correlation of its rows.
  version: 3,
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
  outputs: ['profile', 'intervals', 'matrix', 'table'],
  estimate,
}
