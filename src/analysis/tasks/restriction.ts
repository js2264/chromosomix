/**
 * Where an enzyme cuts the reference, as a descriptor.
 *
 * A Hi-C library is the trace of a digest — its pairs are read against the
 * fragments the enzyme left — and the digest is in no file the reader drops:
 * pairtools has it made by `bioframe.digest` into a fragment BED, ahead of
 * time, for each enzyme. Here it is computed from the reference already loaded,
 * the way the motif search is, and what comes back is the same two objects:
 * one point at each cut, and the cuts per bin on the map's grid. The Pairs QC
 * task requires this one and reads the cuts back out of its result
 * (`genome/restriction.ts`' `cutsOfResult`), so a library's fragment
 * statistics and the lane under the map are one digest.
 *
 * ## Why not the motif search with `GATC` typed into it
 *
 * Because a site is not where an enzyme cuts. `GATC` is a place four bases
 * long; DpnII cuts before its `G`, NlaIII after its `G` of `CATG`, AluI in the
 * middle of `AGCT`, and a fragment boundary is the cut, to the base — which is
 * what pairtools compares a read's position against. And a kit is two enzymes
 * at once, whose cuts are one set of boundaries rather than two lanes.
 *
 * ## The two questions on the form
 *
 * The `enzyme` choice and the `sites` box are the ones Pairs QC asks too, and
 * they are exported for it ({@link ENZYME_PARAM}, {@link SITES_PARAM}) so the
 * two forms cannot drift. There is no multi-choice kind, so several enzymes are
 * a kit in the list or names in the box. **`none` is the default**, which on
 * this form is a run with nothing to cut and is refused by the estimate with
 * a sentence; on Pairs QC's it is the library made with a nuclease, Micro-C or
 * Omni-C, which skips the restriction step.
 */

import { ENZYMES, KITS, enzymeLabel, enzymesFor, siteText } from '../../genome/restriction'
import { fmt } from '../../units'
import { tickedContigs } from '../context'
import type {
  AnalysisContext,
  AnalysisTask,
  ChoiceOption,
  ChoiceParam,
  ContextContig,
  CostEstimate,
  ParamSpec,
  Params,
  TextParam,
} from '../types'
import { READY, waitingFor } from '../types'

/**
 * How many residues are searched at a time — the motif search's
 * `MOTIF_PIECE`, for its reasons, and for one more: a reference held whole is
 * searched in pieces of this size too, as views rather than copies, so a Stop
 * is seen and the progress moves between two of them.
 */
export const RESTRICTION_PIECE = 16_000_000

const ENZYME_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'none',
    label: 'none',
    hint: 'No enzyme: a library cut with a nuclease, as Micro-C and Omni-C are.',
  },
  ...ENZYMES.map((enzyme) => ({
    value: enzyme.name,
    label: `${enzyme.name} (${siteText(enzyme)})`,
  })),
  ...Object.entries(KITS).map(([kit, names]) => ({
    value: kit,
    label: `${kit} (${names.join(' + ')})`,
  })),
  {
    value: 'custom',
    label: 'custom',
    hint: 'Enzymes by name, aliases such as MboI included, or sites typed with a ^ where they cut.',
  },
]

/**
 * The enzyme, as a choice of the presets, the kits, or custom sites typed.
 *
 * Shared with Pairs QC, which lays its own `section` over it.
 */
export const ENZYME_PARAM: ChoiceParam = {
  kind: 'choice',
  key: 'enzyme',
  label: 'enzyme',
  hint: 'The enzyme the library was cut with, or a kit that cuts with several.',
  default: 'none',
  options: ENZYME_OPTIONS,
}

/** The sites, typed, when the enzyme is `custom`. Shared with Pairs QC. */
export const SITES_PARAM: TextParam = {
  kind: 'text',
  key: 'sites',
  label: 'sites',
  placeholder: 'DpnII, G^ANTC',
  hint: 'Enzyme names or IUPAC sites with a ^ where the top strand is cut, separated by commas.',
  default: '',
  when: (params) => params.enzyme === 'custom',
}

const PARAMS: readonly ParamSpec[] = [
  {
    kind: 'sequence',
    key: 'sequence',
    label: 'reference',
    hint: 'The FASTA or .2bit to cut, with its own sequences in its own order.',
  },
  {
    // Which of them, for the motif search's reason: a mammalian reference read
    // by range is read in full to be cut, and one chromosome is a fraction of
    // that read.
    kind: 'sequences',
    key: 'sequences',
    label: 'sequences',
  },
  ENZYME_PARAM,
  SITES_PARAM,
]

/** The two enzyme answers, as `enzymesFor` reads them. */
export function enzymeAnswers(params: Params): { choice: string; sites: string } {
  const choice = typeof params.enzyme === 'string' ? params.enzyme : 'none'
  const sites = typeof params.sites === 'string' ? params.sites : ''
  return { choice, sites }
}

/**
 * Priced before it runs, as the motif search is, and refused where the form
 * cannot be answered.
 *
 * **`free` for a reference held whole**: no read at all, one pass over the
 * residues per enzyme in the worker that holds them. **`scan` for a reference
 * read by range**, whose every base cut is a base read, in requests of
 * {@link RESTRICTION_PIECE}.
 */
function estimate(context: AnalysisContext, params: Params): CostEstimate {
  const free = { class: 'free' as const, requests: 0, bytes: 0, note: 'Nothing to read.' }
  const entry = params.sequence
  if (typeof entry !== 'string' || entry === '') {
    return {
      ...free,
      refusal: 'Choose a reference to cut. A FASTA or a .2bit dropped on the Annotations panel is one.',
    }
  }
  const { choice, sites } = enzymeAnswers(params)
  // The library's own sentence, from the function the runner calls, so a site
  // typed without its ^ is said beside a greyed Run rather than after it.
  const enzymes = enzymesFor(choice, sites)
  if (!Array.isArray(enzymes)) return { ...free, refusal: enzymes.refusal }
  if (enzymes.length === 0) {
    return { ...free, refusal: 'Choose an enzyme or a kit, or type its sites under custom.' }
  }

  const sequence = context.entries.find((row) => row.id === entry)
  const chosen = tickedContigs(context, params, 'sequences')
  if (chosen.length === 0) return { ...free, refusal: 'Tick at least one sequence.' }
  const whole = chosen.length === context.contigs.length
  const what = whole
    ? (sequence?.label ?? 'the reference')
    : chosen.length === 1
      ? chosen[0].name
      : `${fmt.int(chosen.length)} sequences of ${sequence?.label ?? 'the reference'}`
  const label = enzymeLabel(enzymes)

  const byRange = sequence?.byRange
  if (byRange !== undefined) {
    const bases = whole ? byRange.bases : basesOf(chosen)
    const pieces = chosen.reduce(
      (sum, contig) => sum + Math.max(1, Math.ceil(contig.length / RESTRICTION_PIECE)),
      0,
    )
    const remote = sequence?.source.kind === 'remote'
    return {
      class: 'scan',
      requests: remote ? pieces : null,
      bytes: Math.round(bases * byRange.bytesPerBase),
      note:
        `Every base of ${what}, ${(bases / 1e6).toFixed(1)} Mb, read by range and cut with ` +
        `${label} ${fmt.int(RESTRICTION_PIECE / 1e6)} Mb at a time`,
    }
  }

  const bases = basesOf(whole ? context.contigs : chosen)
  return {
    class: 'free',
    requests: 0,
    bytes: 0,
    note:
      `No file reads at all: ${enzymes.length === 1 ? 'one pass' : `${enzymes.length} passes`} ` +
      `over ${what}${bases === 0 ? '' : `, ${(bases / 1e6).toFixed(1)} Mb`}, for ${label}, in ` +
      'the worker that already holds it.',
  }
}

/** The residues of a set of sequences, in base pairs — the assembly's, as the motif search counts them. */
function basesOf(contigs: readonly ContextContig[]): number {
  let total = 0
  for (const contig of contigs) total += contig.length
  return total
}

export const RESTRICTION_TASK: AnalysisTask = {
  id: 'restriction',
  title: 'Restriction sites',
  blurb: 'Where an enzyme cuts the reference, as sites and as a density track.',
  keywords: ['enzyme', 'digest', 'fragments', 'cut sites', 'DpnII', 'MboI', 'HindIII', 'Arima'],
  group: '1d',
  // Beside the residues, for the motif search's reason (`tasks/motif.ts`).
  venue: 'annotations',
  version: 1,
  /**
   * Waiting rather than absent with no reference open, as the motif search is:
   * it applies to any session and is one drag away. No map is needed either —
   * the sites are a lane of their own, and only the density wants a grid.
   */
  availability: (context) =>
    context.entries.some((entry) => entry.kind === 'sequence')
      ? READY
      : waitingFor('Load a FASTA to cut.'),
  params: PARAMS,
  // The sites first, as the motif search's: a point at each cut, then the cuts
  // per bin, which is the picture at genome scale.
  outputs: ['intervals', 'profile'],
  estimate,
}
