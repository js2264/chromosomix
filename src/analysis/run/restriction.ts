/**
 * The restriction digest, run — in the annotations worker, beside the residues.
 *
 * The motif search's shape (`run/motif.ts`), for its reasons: the reference is
 * held in that worker and never shipped out whole, so the cut is made there and
 * what leaves is the cuts — a `FeatureSet` with one point at each, and a vector
 * of cuts per bin on the session's grid.
 *
 * ## Every sequence read is in the answer, cut or not
 *
 * The one thing the sites lane must carry that a motif's need not. Pairs QC
 * reads the cuts back from this result (`cutsOfResult`) and cuts every sequence
 * into fragments with them, so a sequence with no site at all is one fragment,
 * end to end — and that is a different fact from a sequence the run never read,
 * whose pairs are unassigned. So the set lists every sequence the run cut in
 * its `contigs`, the ones with no cut among them, rather than only the ones a
 * feature names.
 *
 * ## Built as typed arrays, not through `FeatureBuilder`
 *
 * A four-cutter on a mammalian genome is millions of cuts, and the builder
 * holds an object per row until it sorts. The cuts arrive sorted and unique per
 * sequence, in the reference's order, which is the order a `FeatureSet` is in,
 * so the arrays are filled directly: a few dozen bytes per cut, and no object.
 *
 * ## Each cut named by its enzyme
 *
 * Which is what gives the bottom strand back. Pairs QC places a `-` read by the
 * bottom-strand cut, `L - 2k` past the top one, and a kit's two enzymes have two
 * overhangs; the name of the enzyme on each cut is what `cutsOfResult` reads
 * the shift from, so the lane and the fragments are one digest.
 */

import type { Contig } from '../../genome/assembly'
import {
  contigCuts,
  cutsIn,
  enzymeLabel,
  enzymesFor,
  kitNamed,
  siteOverlap,
  siteText,
  type CutSites,
  type Enzyme,
} from '../../genome/restriction'
import { motifDensity } from '../../annotations/motifTrack'
import type { FeatureSet } from '../../annotations/types'
import {
  idParam,
  tickedSequences,
  type SequenceReader,
  type TrackJobContext,
  type TrackTaskRunner,
} from '../job'
import { RESTRICTION_PIECE, enzymeAnswers } from '../tasks/restriction'
import type { IntervalsOutput, ProfileOutput, TaskOutput } from '../types'
import { gridContigs, searchedContigs } from './motif'

/** One sequence's cuts, in the order of the top-strand cut, none at its first base or its end. */
export interface ContigCuts {
  contig: string
  length: number
  cuts: CutSites
}

export interface CutScanOptions {
  /** The sequences to cut, in the reference's order; every one where absent. */
  contigs?: readonly Contig[]
  /** Residues cut so far out of all there are, after each piece. */
  progress?: (done: number, total: number, contig: string) => void
  /** Called between two pieces, so a Stop is seen without waiting for the end. */
  throwIfCancelled?: () => void
  /** Residues per piece, {@link RESTRICTION_PIECE} where absent: a test's seams. */
  piece?: number
}

/**
 * Every cut a set of enzymes makes in one loaded reference, sequence by
 * sequence, in the reference's order — a sequence with no cut included, with an
 * empty array.
 *
 * In pieces either way: a reference read by range through `read`, a piece
 * overlapping the next by one base short of the longest site, so a site across
 * a seam lies whole in the piece it starts in; a reference held whole through
 * views of the same length, which copy nothing and let a Stop and the progress
 * through between two of them. `contigCuts` merges the pieces, and a site in an
 * overlap that both pieces found is one cut.
 */
export async function scanCuts(
  reader: SequenceReader,
  enzymes: readonly Enzyme[],
  options: CutScanOptions = {},
): Promise<ContigCuts[]> {
  const contigs = options.contigs ?? reader.contigs
  const overlap = siteOverlap(enzymes)
  const step = Math.max(1, Math.floor(options.piece ?? RESTRICTION_PIECE))
  const read = reader.read?.bind(reader)
  const all = contigs.reduce((sum, contig) => sum + contig.length, 0)
  let done = 0
  const out: ContigCuts[] = []

  for (const contig of contigs) {
    const held = read === undefined ? reader.bases(contig.name) : undefined
    if (read === undefined && held === undefined) continue
    const length = held?.length ?? contig.length
    const pieces: CutSites[] = []
    let readable = true
    for (let from = 0; from < length; from += step) {
      options.throwIfCancelled?.()
      const to = Math.min(length, from + step)
      const end = Math.min(length, to + overlap)
      const bases = held !== undefined ? held.subarray(from, end) : await read?.(contig.name, from, end)
      if (bases === undefined) {
        readable = false
        break
      }
      pieces.push(cutsIn(bases, enzymes, from))
      done += to - from
      options.progress?.(done, all, contig.name)
    }
    if (!readable) continue
    out.push({ contig: contig.name, length, cuts: contigCuts(pieces, length) })
  }
  return out
}

/**
 * What the run is called: the kit by its name and its enzymes, a preset or
 * a list by the enzymes' names.
 */
function digestLabel(choice: string, enzymes: readonly Enzyme[]): string {
  const label = enzymeLabel(enzymes)
  const kit = kitNamed(choice)
  return kit === undefined ? label : `${kit} (${label})`
}

/**
 * The digest as a stretch of an output id: letters, digits and `-` only, since
 * an id is a file name in a shell's output folder. The kit or the preset by its
 * name; a typed list by its enzymes, a site's `^` written `_`, so `G^ANTC` and
 * `GA^NTC` stay two answers.
 */
function digestSlug(choice: string, enzymes: readonly Enzyme[]): string {
  const kit = kitNamed(choice)
  if (kit !== undefined) return kit.replace(/[^A-Za-z0-9]/g, '')
  return enzymes.map((enzyme) => enzyme.name.replace(/\^/g, '_').replace(/[^A-Za-z0-9_]/g, '')).join('-')
}

export const runRestriction: TrackTaskRunner = async (job) => {
  const entry = idParam(job.params, 'sequence')
  if (job.residues === undefined) {
    job.note('This session cannot read residues, so there is no reference to cut.')
    return []
  }
  if (entry === null) {
    job.note('No reference was chosen. Load a FASTA and pick it under Reference.')
    return []
  }
  const reader = job.residues(entry)
  if (reader === undefined) {
    job.note('The reference chosen is no longer loaded. Drop the FASTA again, or pick another.')
    return []
  }
  if (reader.read === undefined && reader.refusal !== undefined) {
    job.note(reader.refusal)
    return []
  }

  // The library's sentence, as the estimate has usually said it already; this
  // is what a stored recipe, a batch or a command line hears, with no form.
  const { choice, sites } = enzymeAnswers(job.params)
  const enzymes = enzymesFor(choice, sites)
  if (!Array.isArray(enzymes)) {
    job.note(enzymes.refusal)
    return []
  }
  if (enzymes.length === 0) {
    job.note('No enzyme was chosen, so there is nothing to cut.')
    return []
  }

  const ticked = tickedSequences(job.params, 'sequences')
  if (ticked !== null && ticked.length === 0) {
    job.note('No sequence is ticked, so there is nothing to cut.')
    return []
  }
  const session = Object.entries(job.inputs.contigLengths ?? {})
    .filter(([, length]) => length > 0)
    .map(([name]) => name)
  const searched = searchedContigs(reader, ticked, session)
  if (searched.length === 0) {
    job.note('None of the ticked sequences is in this reference, so there is nothing to cut.')
    return []
  }
  const whole = searched.length === reader.contigs.length

  job.progress(
    0,
    1,
    searched.length === 1 ? `cutting ${searched[0].name}` : `cutting ${searched.length.toLocaleString()} sequences`,
  )
  const cut = await scanCuts(reader, enzymes, {
    contigs: searched,
    progress: (done, total, contig) => job.progress(done, total, `cutting ${contig}`),
    throwIfCancelled: () => job.throwIfCancelled(),
  })
  job.progress(1, 1, 'done')
  if (cut.length === 0) {
    job.note('None of the ticked sequences could be read from this reference.')
    return []
  }

  const name = digestLabel(choice, enzymes)
  const label = whole
    ? name
    : searched.length <= 3
      ? `${name} on ${searched.map((contig) => contig.name).join(', ')}`
      : `${name} on ${searched.length.toLocaleString()} sequences`
  let total = 0
  let bases = 0
  for (const one of cut) {
    total += one.cuts.top.length
    bases += one.length
  }
  const fragments = total + cut.length
  job.note(
    total === 0
      ? `No ${name} site anywhere in ${whole ? 'this reference' : 'the sequences ticked'}, so each ` +
          'sequence is one fragment.'
      : `${total.toLocaleString()} ${name} ${total === 1 ? 'cut' : 'cuts'} on ` +
          `${cut.length.toLocaleString()} ${cut.length === 1 ? 'sequence' : 'sequences'}: ` +
          `${fragments.toLocaleString()} fragments, ${Math.round(bases / fragments).toLocaleString()} bp ` +
          'long on average.',
  )

  // One id for the pair, as the motif search mints it: the digest, and the
  // sequences where they were not all of them, so two digests in one session
  // are two rows and the same digest run again lands on the rows it made.
  const id = `restriction-${digestSlug(choice, enzymes)}${whole ? '' : scopeId(searched)}`
  const set = cutFeatures(cut, enzymes)
  const outputs: TaskOutput[] = [sitesOutput(set, label, id)]
  const density = densityOutput(job, set, label, id)
  if (density !== null) outputs.push(density)
  return outputs
}

/** The sequences a narrowed digest covered, as a suffix of its id — `run/motif.ts`' rule. */
function scopeId(searched: readonly Contig[]): string {
  const names = searched.map((contig) => contig.name)
  if (names.length <= 3) return `-on-${names.map((one) => one.replace(/[^A-Za-z0-9]/g, '')).join('-')}`
  let sum = 5381
  for (const char of names.join('\n')) sum = ((sum * 33) ^ char.charCodeAt(0)) >>> 0
  return `-on${names.length}-${sum.toString(36)}`
}

/**
 * The cuts, as a `FeatureSet`: one interval per cut, `[c, c + 1)` — the
 * top-strand cut is its start, the first base after it, which is where
 * bioframe's fragment BED starts the fragment to its right, less its two
 * bases. A point on the map and a tick in the lane.
 *
 * **Each cut is named by the enzyme that made it** — `DpnII`, `HinfI`, a typed
 * site with its `^` — which is what a BED of the set says in its fourth column
 * and what the search box finds, and also what gives the bottom-strand cut back
 * to `cutsOfResult`: a kit is two enzymes with two overhangs, so the name is
 * per cut rather than per run. The site goes in the detail; no score and no
 * strand, since a cut has neither.
 */
export function cutFeatures(cut: readonly ContigCuts[], enzymes: readonly Enzyme[]): FeatureSet {
  let n = 0
  for (const one of cut) n += one.cuts.top.length
  const names = enzymes.map((enzyme) => enzyme.name)
  const details = enzymes.map((enzyme) => `${enzyme.name} cuts ${siteText(enzyme)}`)
  const set: FeatureSet = {
    contigs: cut.map((one) => one.contig),
    length: n,
    contig: new Int32Array(n),
    start: new Int32Array(n),
    end: new Int32Array(n),
    strand: new Int8Array(n),
    score: new Float32Array(n).fill(Number.NaN),
    name: new Array<string>(n),
    id: new Array<string>(n).fill(''),
    detail: new Array<string>(n),
    exonAt: new Int32Array(n + 1),
    exonStart: new Int32Array(0),
    exonEnd: new Int32Array(0),
    cdsStart: new Int32Array(n).fill(-1),
    cdsEnd: new Int32Array(n).fill(-1),
    contigAt: new Int32Array(cut.length + 1),
    maxSpan: new Int32Array(cut.length),
  }
  let at = 0
  cut.forEach((one, c) => {
    const { top, enzyme } = one.cuts
    set.contigAt[c] = at
    set.contig.fill(c, at, at + top.length)
    set.start.set(top, at)
    for (let i = 0; i < top.length; i++) {
      set.end[at + i] = top[i] + 1
      set.name[at + i] = names[enzyme[i]]
      set.detail[at + i] = details[enzyme[i]]
    }
    if (top.length > 0) set.maxSpan[c] = 1
    at += top.length
  })
  set.contigAt[cut.length] = at
  return set
}

function sitesOutput(set: FeatureSet, label: string, id: string): IntervalsOutput {
  return {
    kind: 'intervals',
    id,
    label: `${label} sites`,
    payload: { kind: 'features', data: set },
    noun: { one: 'site', many: 'sites' },
    display: 'lane',
    look: 'point',
  }
}

/**
 * Cuts per bin on the session's own grid, as the motif search's density is and
 * for its reason (`run/motif.ts`): the workspace pairs this output's bin size
 * with the session's grid. A cut `c` is counted in the bin holding `c`, so the
 * bin `[start, end)` counts the cuts with `start <= c < end` — the count Pairs
 * QC sets against coverage. An empty bin is a zero.
 */
function densityOutput(
  job: TrackJobContext,
  set: FeatureSet,
  label: string,
  id: string,
): ProfileOutput | null {
  const binsize = job.framing.binsize
  const contigs = gridContigs(job)
  if (!(binsize > 0) || contigs.length === 0) {
    job.note(
      'The sites are a lane; the density is not. A per-bin track needs the bin grid of an open ' +
        'contact map, and this session has none. Open the map and run it again for that half.',
    )
    return null
  }
  // `motifDensity`, so the grid is laid out on the one rule and in the one
  // order the session's is; each sequence's run of the set, as views, is the
  // hits it takes, a one-base site per cut counted at its start.
  const hits = set.contigs.map((contig, c) => {
    const from = set.contigAt[c]
    const to = set.contigAt[c + 1]
    return {
      contig,
      starts: set.start.subarray(from, to),
      ends: set.end.subarray(from, to),
      strands: set.strand.subarray(from, to),
    }
  })
  const vector = motifDensity({ hits, total: set.length, truncated: false }, contigs, binsize)
  return {
    kind: 'profile',
    id: `${id}-density`,
    label: `${label} site density`,
    values: vector.values,
    extent: [0, vector.values.length],
    binsize,
    unit: 'sites',
  }
}
