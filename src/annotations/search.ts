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
 * Features whose name starts with `text`, from the set the star picks.
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
    if (name === '' || !name.toLowerCase().startsWith(query)) continue
    const pad = Math.max(FEATURE_MIN_PAD, Math.round((set.end[i] - set.start[i]) * FEATURE_PAD))
    hits.push({
      name,
      contig: set.contigs[set.contig[i]],
      start: Math.max(0, set.start[i] - pad),
      end: set.end[i] + pad,
      source: source.label,
    })
  }
  return hits
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
