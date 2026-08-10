/**
 * Finding a feature by name, for whichever box a reader typed into.
 *
 * A linear scan over the `name` arrays, capped at the first handful of hits. An
 * index would be the right answer for a million-feature set and is the wrong
 * answer here: the arrays are already in memory, the scan stops at ten matches,
 * and building an index on load would cost every reader who never types in this
 * box.
 *
 * **One feature set, the starred one.** Searching every loaded annotation at
 * once answers "GAL4" with the same gene four times over, differing only in
 * which file it came from — and the four are usually the same coordinates.
 * Which one is searched is a press on the star beside its name.
 *
 * Here rather than in the browser, which is where it was, because a contact map
 * has the same question and the same answer sitting in the same store: a
 * whole-genome map of a mammal is three pixels per chromosome arm, so "go to
 * MYC" is a question that view has to answer without asking for a click on a
 * three-pixel target. What differs between the two surfaces is only the base a
 * coordinate is written in, which is why this returns *numbers*.
 */

import type { AnnotationStore } from './store'

/** A zoomed-to feature keeps this much of its own length as margin on each side. */
export const FEATURE_PAD = 0.25

/** The smallest margin a feature gets, for one too short to make its own. */
export const FEATURE_MIN_PAD = 50

/** How many matches a box offers before it stops looking. */
const MAX_HITS = 10

export interface FeatureHit {
  name: string
  /**
   * The accession, where the file gave one and it is not the name already.
   *
   * `''` otherwise, which is both "this format has no such thing" and "this gene
   * has no symbol, so the name you are reading *is* the accession" — and the
   * label wants the same thing in either case, which is to print it once.
   */
  id: string
  contig: string
  /**
   * The window to open, **0-based half-open** — padded and clamped.
   *
   * The gene's own span plus a margin, because a gene drawn edge to edge in the
   * window is a gene with no context; and 0-based because that is the base the
   * reader's own coordinates are in (`metacooler/range.ts`). A surface that
   * writes 1-based loci adds the one on the way out, where it can see that it is
   * doing so — the browser's `formatLocus` does exactly that.
   */
  start: number
  end: number
  /** The set it came from: the starred one's label. */
  source: string
}

/**
 * Features whose **name or accession** starts with `text`, from the set the star
 * picks.
 *
 * Both, because genomics addresses one gene two ways and a reader uses whichever
 * the thing they are reading used. `LipL1` is what a paper calls it and
 * `PF3D7_1314600` is what the supplementary table calls it, and a box that
 * answered only the first would refuse every identifier pasted out of a
 * spreadsheet. It matters most exactly where the symbols are least useful: a
 * *Plasmodium* annotation has sixty genes called `VAR`, and the accession is the
 * only way to ask for one of them.
 *
 * Empty for a query with a colon in it — that is coordinates, and coordinates
 * have no names to suggest; a list of "no match" hanging under a perfectly good
 * locus is worse than no list. Empty below two characters for the same reason a
 * search box does not answer one letter: everything matches.
 */
export function findFeatures(store: AnnotationStore, text: string, limit = MAX_HITS): FeatureHit[] {
  const raw = text.trim()
  const query = raw.toLowerCase()
  if (query.length < 2 || raw.includes(':')) return []
  const source = store.searchSource()
  if (source === null || source.payload?.kind !== 'features') return []
  const set = source.payload.data
  const hits: FeatureHit[] = []
  for (let i = 0; i < set.length && hits.length < limit; i++) {
    const name = set.name[i]
    const id = set.id[i]
    const matched =
      (name !== '' && name.toLowerCase().startsWith(query)) ||
      (id !== '' && id.toLowerCase().startsWith(query))
    if (!matched) continue
    const pad = Math.max(FEATURE_MIN_PAD, Math.round((set.end[i] - set.start[i]) * FEATURE_PAD))
    hits.push({
      // A gene the file identifies but does not name is drawn as its accession
      // already (`annotations/parse.ts`), so the two are equal rather than the
      // name being empty — and a hit found by id alone still has something to
      // print. `name` is what to read; `id` is what to read it *by*.
      name: name !== '' ? name : id,
      id: id === name ? '' : id,
      contig: set.contigs[set.contig[i]],
      start: Math.max(0, set.start[i] - pad),
      end: set.end[i] + pad,
      source: source.label,
    })
  }
  return hits
}

/**
 * How a hit names itself in either box's list: `LipL1 (PF3D7_1314600)`.
 *
 * Shared so the map's suggestions and the browser's read the same, since the two
 * lists differ only in the base they write coordinates in — which is the one
 * thing they must not share (`ui/SearchBox.ts`).
 */
export function hitLabel(hit: FeatureHit): string {
  return hit.id === '' ? hit.name : `${hit.name} (${hit.id})`
}

/**
 * The window a click on a feature opens, in the same padding as a search hit.
 *
 * Shared so that finding a gene by name and double-clicking the same gene land
 * on the same window — two gestures for one intention, and a reader who used
 * both would otherwise see the picture shift between them.
 */
export function paddedSpan(start: number, end: number): { start: number; end: number } {
  const pad = Math.max(FEATURE_MIN_PAD, Math.round((end - start) * FEATURE_PAD))
  return { start: Math.max(0, start - pad), end: end + pad }
}
