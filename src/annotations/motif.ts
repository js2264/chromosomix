/**
 * Finding a short sequence in a long one, with the degenerate alphabet.
 *
 * A reader who has a reference loaded wants to ask where `GGTCANNNTGACC` is, or
 * `TTAGGG`, or a restriction site — and the answer is a set of intervals, which
 * is a thing this application already knows how to draw, place, export and
 * measure against. So the search itself is the only new part, and this module is
 * deliberately the whole of it: no DOM, no worker, no store, one array of bytes
 * in and a list of hits out. Everything above it is wiring.
 *
 * ## Why masks rather than a regular expression
 *
 * The obvious implementation is to expand the IUPAC codes into a character class
 * and hand the result to `RegExp`. It works, and it is the wrong shape here for
 * three reasons. The residues are a `Uint8Array` and never a string — the FASTA
 * reader keeps them as bytes precisely so a 12 Mb genome is 12 MB rather than
 * 24 (`annotations/fasta.ts`) — so a regular expression would need a decode of
 * every chromosome first, which is the allocation the byte representation exists
 * to avoid. Overlapping hits need `lastIndex` fiddling that is easy to get
 * subtly wrong. And the third is the one that decides it: a regular expression
 * gives no natural place to state what an ambiguous *reference* base means, and
 * that question has a right answer (below) that a character class quietly gets
 * wrong.
 *
 * So a pattern compiles to one 4-bit mask per position — bit 0 `A`, bit 1 `C`,
 * bit 2 `G`, bit 3 `T` — and matching is a mask test per base. `N` is `0b1111`,
 * `R` is `0b0101`, `A` is `0b0001`. A hit is a window where every position
 * passes, and the scan simply restarts at the next offset, so overlapping hits
 * are found by construction rather than by an option.
 *
 * ## What an ambiguous base in the *reference* means
 *
 * The subtle case, and the reason this is a subset test rather than an
 * intersection test. A reference `N` is not a base that happens to be any of
 * four; it is a base nobody knows. Matching it against a pattern `A` would
 * report a site in the middle of an assembly gap — a run of ten thousand `N`s
 * becomes ten thousand hits, all of them fiction, and on a draft assembly that
 * is most of what the reader would see.
 *
 * So a position matches when the residue's own mask is **non-empty and a subset
 * of** the pattern's:
 *
 * - reference `A` against pattern `A`, `R`, `W`, `N` — matches, since `A` is one
 *   of the bases each of those permits;
 * - reference `N` against pattern `A` — does not, because `N` permits three
 *   bases the pattern does not;
 * - reference `N` against pattern `N` — matches, which is right and is the only
 *   way an `N` ever matches anything;
 * - reference `R` against pattern `R` or `N` — matches; against `A` — does not.
 *
 * The non-empty half of the test is what stops a residue that is not a nucleotide
 * at all — a `-` from an alignment, a stray `*`, anything — from matching every
 * pattern by having no bits set to object with.
 *
 * ## Case, and `U`
 *
 * Soft-masking is case, and case here means nothing: a repeat-masked genome
 * writes its repeats in lower case and a reader searching for a motif wants the
 * ones inside repeats too — they can see the case in the sequence lane and
 * decide. `U` is `T`, following `BASE_CODE` in `annotations/fasta.ts`, so the
 * same table serves an RNA reference.
 */

/** One bit per base, in the order `A C G T`. */
const A = 0b0001
const C = 0b0010
const G = 0b0100
const T = 0b1000

/** Every position of a pattern and every residue is one of these. */
export const ANY = A | C | G | T

/**
 * ASCII code point to the set of bases it stands for, `0` for everything else.
 *
 * A 256-entry table rather than a `Map` or a `switch`, for the reason
 * `annotations/fasta.ts` builds `BASE_CODE` the same way: this is indexed once
 * per residue of a chromosome, and an array lookup is the only form of that
 * which stays free at twelve million iterations.
 *
 * The sixteen IUPAC codes are here in both cases, and nothing else is — a `0`
 * entry means "not a nucleotide", which {@link matchesAt} treats as matching
 * nothing rather than as matching everything.
 */
const BASE_MASK = ((): Uint8Array => {
  const table = new Uint8Array(256)
  const codes: Record<string, number> = {
    A,
    C,
    G,
    T,
    U: T,
    R: A | G,
    Y: C | T,
    S: G | C,
    W: A | T,
    K: G | T,
    M: A | C,
    B: C | G | T,
    D: A | G | T,
    H: A | C | T,
    V: A | C | G,
    N: ANY,
  }
  for (const [letter, mask] of Object.entries(codes)) {
    table[letter.charCodeAt(0)] = mask
    table[letter.toLowerCase().charCodeAt(0)] = mask
  }
  return table
})()

/**
 * The complement of a set of bases, as a mask.
 *
 * Built by table rather than by bit twiddling because the swap is `A↔T` and
 * `C↔G`, which is bits 0↔3 and 1↔2 — a reversal of the low nibble, and writing
 * that as a shift expression is four lines nobody can check by reading. Sixteen
 * entries can be checked by reading.
 */
const COMPLEMENT_MASK = ((): Uint8Array => {
  const table = new Uint8Array(16)
  for (let mask = 0; mask < 16; mask++) {
    let out = 0
    if ((mask & A) !== 0) out |= T
    if ((mask & C) !== 0) out |= G
    if ((mask & G) !== 0) out |= C
    if ((mask & T) !== 0) out |= A
    table[mask] = out
  }
  return table
})()

/** A compiled pattern: one mask per position, in reading order. */
export type Motif = Uint8Array

/** Which strand a hit was found on. */
export type MotifStrand = 1 | -1 | 0

/**
 * One occurrence: a half-open interval and the strand it reads on.
 *
 * Half-open and 0-based, which is what `FeatureBuilder.add` takes and what every
 * interval in this application means (§8.3). `strand` is `0` only for a motif
 * that is its own reverse complement — see {@link findMotif}.
 */
export interface MotifHit {
  start: number
  end: number
  strand: MotifStrand
  /**
   * Positions of the window that the pattern does not permit, `0` for an exact
   * match. Never more than {@link MotifSearch.mismatches}.
   */
  mismatches: number
}

/**
 * Why a pattern could not be compiled, in words a reader can act on.
 *
 * A string rather than a code because there is exactly one consumer — a hint
 * line under the input — and a code would only be translated back into this
 * sentence at the one place it is read.
 */
export interface MotifRefusal {
  reason: string
}

export function isMotifRefusal(value: Motif | MotifRefusal): value is MotifRefusal {
  return !(value instanceof Uint8Array)
}

/**
 * The longest pattern worth accepting.
 *
 * Not a limit of the algorithm, which is linear in the sequence and indifferent
 * to the pattern's length. It is a guard on the *shape* of the request: past a
 * few hundred bases somebody is pasting a sequence rather than naming a motif,
 * and what they want is an aligner, which this is not and cannot pretend to be —
 * an exact match of a 5 kb query against a reference is almost always zero hits
 * and a reader concluding the feature is broken.
 */
export const MOTIF_MAX_LENGTH = 200

/**
 * Compile a pattern, or say why not.
 *
 * Whitespace is dropped rather than refused: a motif copied out of a paper
 * arrives as `GGTCA NNN TGACC` about as often as not, and there is nothing a
 * space could mean here other than the reader's own grouping.
 */
export function compileMotif(pattern: string): Motif | MotifRefusal {
  const letters = pattern.replace(/\s+/g, '')
  if (letters === '') return { reason: 'Type a sequence to search for.' }
  if (letters.length > MOTIF_MAX_LENGTH) {
    return {
      reason:
        `${letters.length} bases is longer than this searches for (${MOTIF_MAX_LENGTH}). ` +
        'It looks for short motifs, so a query that long is a job for an aligner.',
    }
  }
  const masks = new Uint8Array(letters.length)
  for (let at = 0; at < letters.length; at++) {
    const mask = BASE_MASK[letters.charCodeAt(at)] ?? 0
    if (mask === 0) {
      return {
        reason:
          `“${letters[at]}” is not a IUPAC base. Use A C G T U and the ambiguity codes ` +
          'R Y S W K M B D H V N.',
      }
    }
    masks[at] = mask
  }
  return masks
}

/** The reverse complement of a compiled pattern. */
export function reverseComplement(motif: Motif): Motif {
  const out = new Uint8Array(motif.length)
  for (let at = 0; at < motif.length; at++) {
    out[at] = COMPLEMENT_MASK[motif[motif.length - 1 - at] ?? 0] ?? 0
  }
  return out
}

/**
 * Whether a motif reads the same on both strands.
 *
 * Worth asking before the search rather than de-duplicating after it. A
 * palindrome — `GAATTC`, and most restriction sites — matches its own reverse
 * complement at exactly the same coordinates, so searching both strands would
 * report every site twice, and a reader counting them would get twice the answer
 * with nothing on screen to explain it.
 */
export function isPalindromic(motif: Motif): boolean {
  const other = reverseComplement(motif)
  for (let at = 0; at < motif.length; at++) if (motif[at] !== other[at]) return false
  return true
}

/**
 * How many positions of the window starting at `from` the pattern does not
 * permit — or `budget + 1` as soon as it is clear the window is out of budget.
 *
 * The subset test the module docstring argues for, counted rather than
 * short-circuited: a position matches when its residue is a nucleotide and every
 * base it could be is one the pattern permits, and any other position is a
 * mismatch. A reference `N` against a pattern base is therefore a mismatch, as
 * it is a failed match at a budget of zero — an assembly gap is not allowed to
 * spend a mismatch it did not earn.
 *
 * The early exit is what keeps a search with a budget no slower than one
 * without: almost every window of a genome fails on its first or second
 * position, and stops there.
 */
function mismatchesAt(bases: Uint8Array, motif: Motif, from: number, budget: number): number {
  let wrong = 0
  for (let at = 0; at < motif.length; at++) {
    const residue = BASE_MASK[bases[from + at] ?? 0] ?? 0
    const allowed = motif[at] ?? 0
    if (residue === 0 || (residue & ~allowed) !== 0) {
      wrong++
      if (wrong > budget) return wrong
    }
  }
  return wrong
}

export interface MotifSearch {
  /** Search the reverse strand as well. Ignored for a palindrome. */
  bothStrands?: boolean
  /**
   * Stop after this many hits.
   *
   * A cap rather than a page: the caller that needs it is drawing, and a lane
   * of four million `N`-heavy hits is a solid bar rather than a picture. The
   * result says whether it was reached, so the reader is told rather than shown
   * a quietly truncated answer.
   */
  limit?: number
  /**
   * Added to every coordinate on the way out.
   *
   * The residues handed in are usually a *window* of a chromosome rather than
   * the whole of it, and a hit's coordinates have to be the chromosome's. Doing
   * it here rather than at the call site is what keeps the two from drifting:
   * the offset is stated once, beside the array it belongs to.
   */
  offset?: number
  /**
   * How many positions of a site may disagree with the pattern. `0`, the
   * default, is an exact match.
   *
   * There for the binding sites that are a *consensus* rather than a string. A
   * bacterial centromere, `parS`, is a 16-base palindrome of which each genome
   * carries a few variants — on *Pseudomonas aeruginosa* PAK an exact search
   * for `TGTTNCACGTGNAACA` finds two of the four sites flanking the origin, and
   * a search allowing one mismatch finds all four and nothing else. A
   * mismatch is a position the pattern does not permit, counted over the
   * whole site; `N` in the pattern permits everything and never costs one.
   */
  mismatches?: number
}

export interface MotifResult {
  hits: MotifHit[]
  /** True when {@link MotifSearch.limit} stopped the scan short of the end. */
  truncated: boolean
}

/**
 * Every occurrence of `motif` in `bases`, overlapping ones included.
 *
 * Overlaps are reported rather than skipped, because for a motif they are real:
 * `AA` occurs twice in `AAA`, and a reader counting `CA` repeats wants both. The
 * scan advances one base at a time for that reason, which also makes the cost
 * flatly `O(bases × motif)` with no pathological input.
 *
 * Hits come out in coordinate order with the forward strand first at any shared
 * position, which is the order a lane wants and saves the caller a sort.
 *
 * `strand: 0` — "both" — is reported only for a palindrome *when both strands
 * were asked for*, and that pairing is deliberate rather than incidental. A
 * palindrome matches its own reverse complement at identical coordinates, so a
 * both-strand search of `GAATTC` would otherwise report every site twice and a
 * reader counting them would get double the answer with nothing on screen to
 * explain it. But a reader who asked for the forward strand only asked a
 * narrower question, and `0` would answer a wider one they did not ask: their
 * hits are forward-strand hits, which is what `1` says.
 */
export function findMotif(
  bases: Uint8Array,
  motif: Motif,
  options: MotifSearch = {},
): MotifResult {
  const hits: MotifHit[] = []
  if (motif.length === 0 || bases.length < motif.length) return { hits, truncated: false }

  const offset = options.offset ?? 0
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  // Never as many as the motif is long: a budget that covers every position
  // matches every window of the reference, which is not a search.
  const budget = Math.max(0, Math.min(motif.length - 1, Math.floor(options.mismatches ?? 0)))
  const both = options.bothStrands === true
  const palindrome = both && isPalindromic(motif)
  const reverse = both && !palindrome ? reverseComplement(motif) : null
  const forwardStrand: MotifStrand = palindrome ? 0 : 1

  const last = bases.length - motif.length
  for (let from = 0; from <= last; from++) {
    const forward = mismatchesAt(bases, motif, from, budget)
    if (forward <= budget) {
      hits.push({
        start: from + offset,
        end: from + motif.length + offset,
        strand: forwardStrand,
        mismatches: forward,
      })
      if (hits.length >= limit) return { hits, truncated: from < last }
    }
    if (reverse !== null) {
      const back = mismatchesAt(bases, reverse, from, budget)
      if (back <= budget) {
        hits.push({
          start: from + offset,
          end: from + motif.length + offset,
          strand: -1,
          mismatches: back,
        })
        if (hits.length >= limit) return { hits, truncated: from < last }
      }
    }
  }
  return { hits, truncated: false }
}

/**
 * How many bases at the end of a window a hit could still straddle.
 *
 * A genome is searched in chunks — the residues do not arrive all at once and a
 * chromosome is not held twice — and a motif spanning a chunk boundary is found
 * by neither chunk unless they overlap. The overlap that is exactly enough is
 * one base short of the motif's length: any hit needs at least one base on each
 * side of the seam, so a window carrying the previous window's last
 * `motif.length - 1` residues sees every one of them.
 *
 * Exported because the caller doing the chunking is the one that has to apply
 * it, and a caller inventing its own value would be inventing a number this
 * module is the only place able to justify.
 */
export function motifOverlap(motif: Motif): number {
  return Math.max(0, motif.length - 1)
}
