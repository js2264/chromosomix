/**
 * The motif search, run — in the annotations worker, beside the residues.
 *
 * The whole shape of this is set by where the bytes are. A reference is parsed
 * into the annotations worker and deliberately never leaves it whole: `bases`
 * answers a window and is capped, precisely so that opening a genome does not
 * put twelve megabytes on the main thread. So the scan happens here, against
 * `TrackJobContext.residues`, and what goes back is the handful of coordinates
 * that came out — a `FeatureSet` and a vector, both of which cross a thread
 * boundary as typed arrays.
 *
 * ## Two outputs, because a set of sites is two different pictures
 *
 * `annotations/motifTrack.ts` argues it in full and both builders are its. A
 * `FeatureSet` answers *where exactly*, and at chromosome scale it is a picket
 * fence. A per-bin count answers *how dense here*, and at base scale it is a bar
 * chart of ones. Neither is both, so one scan makes both, and the reader closes
 * whichever they do not want with the same × as every other row.
 *
 * ## The two decisions that are biology rather than plumbing
 *
 * Both are inherited and neither may be lost in the move from the card:
 *
 * - **A reference `N` does not satisfy a pattern naming a base.** An assembly
 *   gap is a base nobody knows rather than a base that is any of four, so
 *   `annotations/motif.ts` matches on a subset test; without it a run of ten
 *   thousand `N`s is ten thousand fictional hits and a draft assembly is a solid
 *   bar of them.
 * - **A palindrome searched on both strands is reported once**, with `strand: 0`
 *   rather than twice at identical coordinates — otherwise a reader counting the
 *   sites of `GAATTC` gets double the answer with nothing on screen to explain
 *   it.
 *
 * And a third that belongs to the density lane: **an empty bin is a zero, never
 * `NaN`**. `NaN` in a `ProfileOutput` means *nothing is known here* and draws as
 * a hole, which for a count is the opposite claim — a stretch with no sites in
 * it is the most informative thing a restriction map has to say.
 */

import { compileMotif, findMotif, isMotifRefusal, type Motif } from '../../annotations/motif'
import {
  motifDensity,
  motifFeatures,
  motifLabel,
  type MotifHits,
  type MotifScanResult,
} from '../../annotations/motifTrack'
import type { Contig } from '../../genome/assembly'
import {
  boolParam,
  idParam,
  numParam,
  type SequenceReader,
  type TrackJobContext,
  type TrackTaskRunner,
} from '../job'
import { MOTIF_SITE_LIMIT, motifPattern } from '../tasks/motif'
import type { IntervalsOutput, ProfileOutput, TaskOutput } from '../types'

/**
 * Every occurrence of a motif in one loaded reference.
 *
 * Folded in here rather than left in the worker as the `motif` request's
 * handler, which is where it was: that request had exactly one caller, the
 * bespoke card, and with the card gone a function in the worker called only from
 * this module would be an indirection with nothing on the other end of it. What
 * stays in the worker is the part only the worker can do — holding the store and
 * resolving a name onto it ({@link SequenceReader}).
 *
 * In sequence order, one entry per contig that has a hit at all — a contig with
 * none is omitted rather than carried as three empty arrays, since a draft
 * assembly is mostly contigs with no hit in them and the empty entries would
 * outnumber the real ones.
 *
 * The walk is over the reader's `contigs` rather than over its bytes, so the
 * order is the reference's own; `bases` then resolves the spelling, which is
 * what searches a FASTA renamed into the map's vocabulary under the names the
 * rest of the application uses (§5.9).
 */
export function scanMotif(
  reader: SequenceReader,
  motif: Motif,
  options: { bothStrands: boolean; limit: number },
): MotifScanResult {
  const cap = Math.max(1, Math.min(options.limit, MOTIF_SITE_LIMIT))
  const hits: MotifHits[] = []
  let total = 0
  let truncated = false

  for (const contig of reader.contigs) {
    if (total >= cap) {
      // Stopped with sequences left unread, which is a truncated answer even
      // though the last contig searched finished cleanly.
      truncated = true
      break
    }
    const bases = reader.bases(contig.name)
    if (bases === undefined) continue
    // One more than there is room for, and then the extra is dropped. Asking for
    // exactly the remaining budget cannot tell "the cap fell on the last site
    // there was" from "the cap cut the answer short" — `findMotif` stops on the
    // site that fills the budget and has no way to know whether another follows
    // without looking. Looking costs one more site's worth of scan and buys the
    // difference between a complete answer and a claim of truncation on one.
    const room = cap - total
    const found = findMotif(bases, motif, { bothStrands: options.bothStrands, limit: room + 1 })
    const kept = Math.min(found.hits.length, room)
    if (found.truncated || found.hits.length > room) truncated = true
    if (kept === 0) continue

    const starts = new Int32Array(kept)
    const ends = new Int32Array(kept)
    const strands = new Int8Array(kept)
    for (let at = 0; at < kept; at++) {
      const hit = found.hits[at]
      starts[at] = hit.start
      ends[at] = hit.end
      strands[at] = hit.strand
    }
    hits.push({ contig: contig.name, starts, ends, strands })
    total += kept
  }
  return { hits, total, truncated }
}

export const runMotif: TrackTaskRunner = async (job) => {
  const entry = idParam(job.params, 'sequence')
  // The capability, not the entry: a context with no `residues` at all is a host
  // that holds no genome, which is a different sentence from a reference the
  // reader has since dropped. Both are notes rather than throws — a parameter
  // that cannot be honoured is a fact about the form, and §18.3's red card is
  // for something having gone wrong (`analysis/run/metaplot.ts` does the same).
  if (job.residues === undefined) {
    job.note('This session cannot read residues, so there is no reference to search.')
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

  const pattern = motifPattern(job.params)
  const compiled = compileMotif(pattern)
  // **A pattern that will not compile is not an exception.** `compileMotif`
  // hands back a sentence about what the reader typed — "“X” is not a IUPAC
  // base" — and a note is where a sentence like that belongs: the drawer lists
  // the notes under the run it finished, where a throw would show a red card for
  // a typo the reader can fix in the box above it (§18.3, and `run/metaplot.ts`
  // answers a missing input the same way). The *form* has usually said it
  // already, through this same function in the task's estimate, with **Run**
  // greyed out; this is the path a stored recipe and a batch arrive by, where
  // there was no form to say it.
  if (isMotifRefusal(compiled)) {
    job.note(compiled.reason)
    return []
  }

  const bothStrands = boolParam(job.params, 'bothStrands', true)
  const limit = Math.max(1, Math.round(numParam(job.params, 'limit', MOTIF_SITE_LIMIT)))

  job.progress(0, 1, `Searching ${reader.contigs.length.toLocaleString()} sequences`)
  const result = scanMotif(reader, compiled, { bothStrands, limit })
  job.progress(1, 1, 'Done')

  const label = motifLabel(pattern, bothStrands)
  if (result.total === 0) {
    job.note(`No match for ${label} anywhere in this reference.`)
    return []
  }
  const sites = `${result.total.toLocaleString()} site${result.total === 1 ? '' : 's'}`
  job.note(
    result.truncated
      ? `${sites} — the search stopped at the limit of ${limit.toLocaleString()} and there are ` +
          'more. Raise “Most sites”, or narrow the pattern.'
      : `${sites}, on ${result.hits.length.toLocaleString()} ` +
          `${result.hits.length === 1 ? 'sequence' : 'sequences'}.`,
  )

  // One id for the pair, minted once. It carries the pattern **and** the strand
  // because two searches in one session are two different answers, and one id
  // for both would make the second silently replace the first — the workspace
  // keeps one row per output id, on purpose. Re-running the *same* search still
  // lands on the rows it made last time, which is what a reader refining a
  // pattern wants and what **Recompute** depends on. Letters and digits only by
  // construction: `motifPattern` dropped the whitespace and upper-cased it, and
  // `compileMotif` accepted every character that is left.
  const id = `motif-${pattern}${bothStrands ? '-both' : ''}`
  const outputs: TaskOutput[] = [sitesOutput(result, pattern, label, id)]
  const density = densityOutput(job, result, label, id)
  if (density !== null) outputs.push(density)
  return outputs
}

/**
 * The sites, as an interval set.
 *
 * Straight onto an entry from here: a `FeatureSet` is what a parsed BED would
 * have produced, so it becomes an ordinary overlay row with the same colour, the
 * same shape controls and the same **Save as BED** as a file the reader dropped
 * (`AnalysisWorkspace.adoptIntervals`). The names and the empty score column are
 * `motifFeatures`' decisions and are argued there.
 */
function sitesOutput(
  result: MotifScanResult,
  pattern: string,
  label: string,
  id: string,
): IntervalsOutput {
  return {
    kind: 'intervals',
    id,
    label,
    payload: { kind: 'features', data: motifFeatures(result, pattern) },
  }
}

/**
 * Sites per bin, on the session's **own** bin grid.
 *
 * This is the one decision in the task that is not obvious, and getting it wrong
 * produces a lane that is drawn in the wrong places rather than one that is
 * missing. The bespoke card chose a bin size from the *size of the genome* — a
 * `motifBinsize` that aimed at twenty thousand bins and snapped to a round
 * number — and for the card that was right: it laid the vector out over the
 * assembly itself, so it owned both halves of the grid and they agreed by
 * construction. That function is gone with the card, because a task has no use
 * for it.
 *
 * A task does not own both halves. `AnalysisWorkspace.register` takes the
 * `binsize` off this output and pairs it with the *session's* contig grid —
 * `startBin` and `bins` per sequence, at the open file's resolution — and
 * `binVectorSamples` then reads a value at `contig.startBin + floor(bp /
 * binsize)`. Hand it a bin size the grid was not built with and every value
 * lands at the wrong multiple of it: a 1 kb density registered against a 5 kb
 * grid draws each chromosome's sites compressed into the first fifth of it, on
 * the wrong chromosome for all but the first. So the bin size **is the
 * framing's**, always, and the grid below is rebuilt on exactly the rule
 * `analysis/context.ts` builds the session's with.
 *
 * The cost is a coarser picture than the card's on a coarse map, and that is the
 * right trade: a lane on a private grid is a lane that cannot be compared with
 * the insulation track above it or the coverage track below it, which is most of
 * what a lane is for (§18.5).
 *
 * **Where there is no grid there is no lane, and the run says so.** A 1D browser
 * session has no map, so `AnalysisFraming.binsize` is `0` — there is no
 * resolution to be on — and the sites lane above, which carries its own
 * coordinates, is the whole of what a browser session gets.
 */
function densityOutput(
  job: TrackJobContext,
  result: MotifScanResult,
  label: string,
  id: string,
): ProfileOutput | null {
  const binsize = job.framing.binsize
  const contigs = gridContigs(job)
  if (!(binsize > 0) || contigs.length === 0) {
    job.note(
      'The sites are a lane; the density is not. A per-bin track needs the bin grid of an open ' +
        'contact map, and this session has none — so there is nothing for a density to be ' +
        'per. Open the map and run it again for that half.',
    )
    return null
  }
  // `motifDensity` lays the grid out itself, on the same rule and in the same
  // order — a bin per `ceil(length / binsize)`, cumulative — so the vector and
  // the grid the workspace registers it against agree bin for bin.
  const vector = motifDensity(result, contigs, binsize)
  return {
    kind: 'profile',
    id: `${id}-density`,
    label: `${label} density`,
    values: vector.values,
    extent: [0, vector.values.length],
    binsize,
    // Sites, and a count rather than a rate: the bin size is fixed across the
    // lane, so dividing by it would scale every value by the same number and
    // lose the property that the lane's values sum to the site count.
    unit: 'sites',
  }
}

/**
 * The sequences the session's bin grid is laid out over, in its order.
 *
 * From `inputs.contigLengths`, which is the only assembly this venue is given:
 * the annotations worker holds handles and parsed sets, and neither of those is
 * an assembly. It is built by `AnalysisWorkspace` from the very list its `grid`
 * walks, so the order here is the order the startBins were computed in — which
 * is the property this whole function turns on, and the reason it is not
 * rebuilt from the reference's own contigs: a FASTA lists its sequences in its
 * own order, and a grid built in that order would put every contig after the
 * first disagreement at the wrong absolute bin.
 *
 * Zero-length sequences are dropped, because the session's grid gives them no
 * bins at all (`binsForLength`) while `motifDensity` gives every sequence at
 * least one — a divergence of one bin that would shift everything after them.
 *
 * The one thing a record cannot promise is its own order for a **numeric** name:
 * `Object.entries` puts canonical integer keys — `1`, `2`, `10`, which is how a
 * `.hic` spells its chromosomes — ascending and ahead of the rest, whatever
 * order they were inserted in. That is the same order every such file lists them
 * in, so the two agree in practice; a file that listed `10` before `2` would be
 * the one shape this cannot follow, and the density lane is what would be wrong
 * rather than the sites. Written down rather than guarded, because the guard
 * would need a fact this venue is not given: the startBins themselves.
 */
function gridContigs(job: TrackJobContext): Contig[] {
  const lengths = job.inputs.contigLengths
  if (lengths === undefined) return []
  const out: Contig[] = []
  for (const [name, length] of Object.entries(lengths)) {
    if (length > 0) out.push({ name, length })
  }
  return out
}
