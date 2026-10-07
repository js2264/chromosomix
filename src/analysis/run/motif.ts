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

import {
  compileMotif,
  findMotif,
  isMotifRefusal,
  motifOverlap,
  type Motif,
  type MotifHit,
} from '../../annotations/motif'
import {
  motifDensity,
  motifFeatures,
  motifLabel,
  type MotifHits,
  type MotifScanResult,
} from '../../annotations/motifTrack'
import type { Contig } from '../../genome/assembly'
import { contigIndexOf } from '../../genome/naming'
import {
  boolParam,
  idParam,
  numParam,
  tickedSequences,
  type SequenceReader,
  type TrackJobContext,
  type TrackTaskRunner,
} from '../job'
import { MOTIF_PIECE, MOTIF_SITE_LIMIT, motifPattern } from '../tasks/motif'
import type { IntervalsOutput, ProfileOutput, TaskOutput } from '../types'

/** What {@link scanMotif} is asked: the search, and where it may report its progress. */
export interface MotifScanOptions {
  bothStrands: boolean
  limit: number
  mismatches?: number
  /**
   * The reference's sequences to search, in its own order; every one where
   * absent (see {@link searchedContigs}).
   */
  contigs?: readonly Contig[]
  /** Residues searched so far out of all there are to search, after each piece. */
  progress?: (done: number, total: number, contig: string) => void
  /** Called between two pieces, so a Stop is seen without waiting for the end. */
  throwIfCancelled?: () => void
  /**
   * Residues per piece, {@link MOTIF_PIECE} where absent: a test's way to put
   * seams where it can see them without carrying sixteen megabases to do it.
   */
  piece?: number
}

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
 *
 * **A reference read by range is searched through `read`**, in pieces of
 * {@link MOTIF_PIECE} residues that overlap by `motifOverlap` — one base short
 * of the motif, which is exactly enough for a site straddling a seam to lie
 * whole in one piece, and never in both: a piece reading `[a, b + overlap)`
 * holds every site starting in `[a, b)` and no other. So the answer is the
 * one a held reference gives, site for site, and only the memory differs.
 */
export async function scanMotif(
  reader: SequenceReader,
  motif: Motif,
  options: MotifScanOptions,
): Promise<MotifScanResult> {
  // The same ceiling {@link MOTIF_SITE_LIMIT} names and `runMotif` has already
  // applied, kept here as the last line of defence for a caller that reaches
  // this function directly. It must not be the *only* place it is applied: when
  // it was, a run asked for two million sites capped at five hundred thousand
  // and then reported the two million back, which is the one thing a truncation
  // note must never do.
  const cap = Math.max(1, Math.min(options.limit, MOTIF_SITE_LIMIT))
  const budget = options.mismatches ?? 0
  const contigs = options.contigs ?? reader.contigs
  const overlap = motifOverlap(motif)
  const read = reader.read?.bind(reader)
  const step = Math.max(1, Math.floor(options.piece ?? MOTIF_PIECE))
  const hits: MotifHits[] = []
  let total = 0
  let truncated = false
  const all = contigs.reduce((sum, contig) => sum + contig.length, 0)
  let done = 0

  for (const contig of contigs) {
    if (total >= cap) {
      // Stopped with sequences left unread, which is a truncated answer even
      // though the last contig searched finished cleanly.
      truncated = true
      break
    }
    const found: MotifHit[] = []
    let full = false
    // One more than there is room for, and then the extra is dropped. Asking for
    // exactly the remaining budget cannot tell "the cap fell on the last site
    // there was" from "the cap cut the answer short" — `findMotif` stops on the
    // site that fills the budget and has no way to know whether another follows
    // without looking. Looking costs one more site's worth of scan and buys the
    // difference between a complete answer and a claim of truncation on one.
    const search = (bases: Uint8Array, offset: number): void => {
      const room = cap - total - found.length
      const piece = findMotif(bases, motif, {
        bothStrands: options.bothStrands,
        limit: room + 1,
        mismatches: budget,
        offset,
      })
      for (let at = 0; at < Math.min(piece.hits.length, room); at++) found.push(piece.hits[at])
      if (piece.truncated || piece.hits.length > room) full = true
    }

    if (read === undefined) {
      const bases = reader.bases(contig.name)
      if (bases === undefined) continue
      search(bases, 0)
      done += contig.length
      options.progress?.(done, all, contig.name)
    } else {
      for (let from = 0; from < contig.length && !full; from += step) {
        options.throwIfCancelled?.()
        const to = Math.min(contig.length, from + step)
        const bases = await read(contig.name, from, Math.min(contig.length, to + overlap))
        if (bases === undefined) break
        search(bases, from)
        done += to - from
        options.progress?.(done, all, contig.name)
      }
    }
    if (full) truncated = true

    const kept = found.length
    if (kept === 0) {
      if (full) break
      continue
    }
    const starts = new Int32Array(kept)
    const ends = new Int32Array(kept)
    const strands = new Int8Array(kept)
    // Carried only where the search allowed any, so an exact search's sites
    // keep the empty score column `motifFeatures` argues for.
    const wrong = budget > 0 ? new Uint8Array(kept) : undefined
    for (let at = 0; at < kept; at++) {
      const hit = found[at]
      starts[at] = hit.start
      ends[at] = hit.end
      strands[at] = hit.strand
      if (wrong !== undefined) wrong[at] = hit.mismatches
    }
    hits.push({
      contig: contig.name,
      starts,
      ends,
      strands,
      ...(wrong === undefined ? {} : { mismatches: wrong }),
    })
    total += kept
    if (full) break
  }
  return { hits, total, truncated }
}

/**
 * The reference's sequences a run searches, in the reference's own order.
 *
 * The `sequences` parameter names them in the session's vocabulary, and the
 * reference is reached through `contigIndexOf`, so a FASTA that writes `chr1`
 * is searched for a map that writes `1` (§5.9). **Every sequence of the session
 * ticked is the whole reference**, sequences the map has not got included —
 * which is what the search did before it had a list, and what *all of them*
 * means to a reader who has not unticked a box; a list short of that is exactly
 * the sequences on it. Unanswered (`null`, a job that never met a form) is the
 * whole reference too.
 */
export function searchedContigs(
  reader: SequenceReader,
  ticked: readonly string[] | null,
  session: readonly string[],
): Contig[] {
  if (ticked === null) return [...reader.contigs]
  const chosen = new Set(ticked)
  if (session.length > 0 && session.every((name) => chosen.has(name))) return [...reader.contigs]
  const wanted = new Set<number>()
  for (const name of ticked) {
    const at = contigIndexOf(reader.contigs, name)
    if (at >= 0) wanted.add(at)
  }
  return reader.contigs.filter((_, at) => wanted.has(at))
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
  // A reference read by range refuses to be read *whole*, and a search does not
  // need it whole: it reads a piece at a time through `read`. The refusal is
  // for a host that offers neither.
  if (reader.read === undefined && reader.refusal !== undefined) {
    job.note(reader.refusal)
    return []
  }

  // Unanswered is every sequence and an empty list is nothing (§18.2), as for
  // every task with this list; the estimate refuses the second before it is
  // sent, and this is what one that arrives anyway hears.
  const ticked = tickedSequences(job.params, 'sequences')
  if (ticked !== null && ticked.length === 0) {
    job.note('No sequence is ticked, so there is nothing to search.')
    return []
  }
  const session = Object.entries(job.inputs.contigLengths ?? {})
    .filter(([, length]) => length > 0)
    .map(([name]) => name)
  const searched = searchedContigs(reader, ticked, session)
  if (searched.length === 0) {
    job.note('None of the ticked sequences is in this reference, so there is nothing to search.')
    return []
  }
  const whole = searched.length === reader.contigs.length

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
  // Clamped to the ceiling here and not only inside `scanMotif`, because this is
  // the number every sentence below quotes. The spec carries the same `max`, so
  // a form can no longer submit a larger one — but a stored recipe written
  // before it did, a batch and the CLI never pass through a form, and a note
  // naming a limit the scan never used is a note that sends the reader to raise
  // a control which cannot help them.
  const limit = Math.min(
    MOTIF_SITE_LIMIT,
    Math.max(1, Math.round(numParam(job.params, 'limit', MOTIF_SITE_LIMIT))),
  )

  // Never as many as the motif is long, which would match every window; the
  // matcher holds the same line, and this is the number the label quotes.
  const mismatches = Math.max(
    0,
    Math.min(compiled.length - 1, Math.round(numParam(job.params, 'mismatches', 0))),
  )

  job.progress(
    0,
    1,
    searched.length === 1
      ? `searching ${searched[0].name}`
      : `searching ${searched.length.toLocaleString()} sequences`,
  )
  const result = await scanMotif(reader, compiled, {
    bothStrands,
    limit,
    mismatches,
    contigs: searched,
    // Only a reference read by range reports as it goes: a held one is one
    // pass over memory, done before a bar could be drawn.
    ...(reader.read === undefined
      ? {}
      : {
          progress: (done: number, total: number, contig: string) =>
            job.progress(done, total, `searching ${contig}`),
          throwIfCancelled: () => job.throwIfCancelled(),
        }),
  })
  job.progress(1, 1, 'done')

  const label = scopedLabel(motifLabel(pattern, bothStrands, mismatches), searched, whole)
  if (result.total === 0) {
    job.note(
      whole
        ? `No match for ${label} anywhere in this reference.`
        : `No match for ${label}.`,
    )
    return []
  }
  const sites = `${result.total.toLocaleString()} site${result.total === 1 ? '' : 's'}`
  // Two remedies, because only one of them is ever true. Below the ceiling the
  // reader owns the limit and raising it finds more; *at* the ceiling there is
  // nothing to raise — 500,000 is the most one run reports — and the old
  // sentence prescribed the raise anyway, so a reader who followed it got the
  // identical answer back with the identical note under it and no way to learn
  // why. `limit` is the clamped number, so the figure quoted is the one the
  // scan actually stopped at.
  job.note(
    result.truncated
      ? `${sites} — the search stopped at the limit of ${limit.toLocaleString()} and there are ` +
          'more. ' +
          (limit < MOTIF_SITE_LIMIT
            ? 'Raise “Most sites”, or narrow the pattern.'
            : searched.length > 1
              ? 'That is the most one run reports, so narrow the pattern or tick fewer sequences.'
              : 'That is the most one run reports, so narrow the pattern.')
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
  // `compileMotif` accepted every character that is left. A search over some of
  // the sequences carries them too, for the same reason: chr1 searched and then
  // chr2 are two answers, and the second must not take the first one's rows.
  const id =
    `motif-${pattern}${bothStrands ? '-both' : ''}${mismatches > 0 ? `-mm${mismatches}` : ''}` +
    (whole ? '' : scopeId(searched))
  const outputs: TaskOutput[] = [sitesOutput(result, pattern, label, id)]
  const density = densityOutput(job, result, label, id)
  if (density !== null) outputs.push(density)
  return outputs
}

/**
 * A run's label, with the sequences it searched where they were not all of them.
 *
 * Named outright up to three — *GATC (both strands) on chr1* is the row a
 * reader searching chromosome by chromosome needs to tell from the next one —
 * and counted past that, where a list would be longer than the lane's name.
 */
function scopedLabel(label: string, searched: readonly Contig[], whole: boolean): string {
  if (whole) return label
  return searched.length <= 3
    ? `${label} on ${searched.map((contig) => contig.name).join(', ')}`
    : `${label} on ${searched.length.toLocaleString()} sequences`
}

/**
 * The sequences a narrowed search covered, as a suffix of its output id.
 *
 * Letters and digits from each name up to three, as the label names them, and
 * past that the count and a checksum of the list — two different sets of five
 * sequences are two answers, and the count alone would file them as one.
 */
function scopeId(searched: readonly Contig[]): string {
  const names = searched.map((contig) => contig.name)
  if (names.length <= 3) return `-on-${names.map((name) => name.replace(/[^A-Za-z0-9]/g, '')).join('-')}`
  let sum = 5381
  for (const char of names.join('\n')) sum = ((sum * 33) ^ char.charCodeAt(0)) >>> 0
  return `-on${names.length}-${sum.toString(36)}`
}

/**
 * The sites, as an interval set.
 *
 * Straight onto an entry from here: a `FeatureSet` is what a parsed BED would
 * have produced, so it becomes an ordinary row of the Tracks card — a 1D track,
 * or a set of points on the map — with the same colour, the same controls and
 * the same **Save as BED** as a file the reader dropped
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
    noun: { one: 'site', many: 'sites' },
    // Places: a track beside the map, and a point on it where the reader puts
    // them there (§18.7).
    display: 'lane',
    look: 'point',
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
export function gridContigs(job: TrackJobContext): Contig[] {
  const lengths = job.inputs.contigLengths
  if (lengths === undefined) return []
  const out: Contig[] = []
  for (const [name, length] of Object.entries(lengths)) {
    if (length > 0) out.push({ name, length })
  }
  return out
}
