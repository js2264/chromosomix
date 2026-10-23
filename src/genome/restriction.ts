/**
 * Where a restriction enzyme cuts a reference, and what that says about a
 * library of pairs.
 *
 * A Hi-C library is made by cutting chromatin with an enzyme and ligating the
 * ends back together, so every read pair carries the trace of the cuts: the two
 * ends sit near a site, a pair whose ends share a fragment was never ligated to
 * anything else, and a fragment no pair touched is one the library never saw.
 * pairtools answers those questions from a fragment BED written by
 * `bioframe.digest` and `pairtools restrict`; this module is the same
 * computation in one pass, beside a reference already loaded, with no file
 * written in between.
 *
 * It is the whole of the computation and nothing else — no DOM, no worker, no
 * store. `analysis/run/restriction.ts` walks a reference with {@link cutsIn},
 * and the Pairs QC task feeds a `.pairs` through a {@link RestrictionCounter};
 * both are wiring around what is here.
 *
 * ## The cut, exactly — on both strands
 *
 * A site is written with a `^` where the enzyme cuts the top strand —
 * `^GATC`, `G^ANTC`, `CATG^` — and {@link Enzyme.cut} is the number of site
 * bases `k` before it. A match whose first base is at 0-based `s` cuts the top
 * strand at `c = s + k`, the index of the first base after the cut, and the
 * bottom strand at `c' = s + L - k` in the same coordinates, `L` being the
 * site's length: DpnII cuts at `s` and `s + 4`, HinfI at `s + 1` and `s + 4`,
 * NlaIII at `s + 4` and `s`, AluI at `s + 2` twice. Every preset is a
 * palindrome, so its two strands give one cut.
 *
 * A typed site that is not a palindrome also matches its reverse complement,
 * and its bottom strand is taken to be cut symmetrically, as a palindrome's is.
 * A reverse match at `s` then cuts at the same two places a forward one does —
 * the site's strand `k` bases from its 5′ end, which is `s + L - k` on the
 * bottom, and the other strand `k` bases from its own, `s + k` on the top — so
 * the top cut is `s + k` whichever strand the site was read on. That is where
 * Biopython puts it too: its `search` reports a reverse BssSI (`C^ACGAG`) or
 * BbvCI (`CC^TCAGC`) site at the same top-strand cut as a forward one, and the
 * golden holds a typed `C^ACGAG` to BssSI's digest.
 *
 * The matching is `annotations/motif.ts`' and is not repeated here: the IUPAC
 * masks, the rule that a reference `N` matches only a pattern `N`, case
 * ignored, every overlapping match found. What this adds is the offset from a
 * match to its cuts.
 *
 * **`bioframe.digest` is two bases late**, and the goldens and the validation
 * notebook allow for it rather than copy it: Biopython's `search` already
 * returns the 1-based first base after the cut, and bioframe adds one more on
 * the way to a 0-based start. So its boundaries are the top-strand cuts plus
 * two, at every site (`scripts/make_restriction_golden.py`).
 *
 * ## The fragment, exactly — placed by the strand that was read
 *
 * On a sequence of length `N`, the top boundaries are `B = [0, …c, N]` and the
 * bottom ones `B' = [0, …c', N]`, both in the order of `c`, so fragment `i` is
 * one fragment: `[B[i], B[i+1])` on the top strand and `[B'[i], B'[i+1])` on
 * the bottom. A pair end at the 1-based `pos` a `.pairs` file writes is at
 * `x = pos - 1`; a `+` end lies in fragment `searchsorted(B, x, 'right') - 1`
 * and a `-` end in `searchsorted(B', x, 'right') - 1`, each clamped to the
 * sequence's fragments as `pairtools restrict` clamps (see {@link fragmentOf}).
 *
 * The bottom strand is the part that is easy to get wrong. A `-` read's 5′ end
 * is the bottom strand's, and once a 5′ overhang is filled in, a fragment's end
 * on the bottom strand is at `c' - 1` — three bases past the top-strand cut for
 * DpnII. Placed by the top-strand cut, the `-` read of every DpnII dangling end
 * falls in the next fragment and the pair reads as a re-ligation.
 */

import { compileMotif, findMotif, isMotifRefusal, type Motif } from '../annotations/motif'
import type { IntervalsOutput, TaskResult } from '../analysis/types'
import { distEdges } from '../pairs/stats'
import { contigIndexOf } from './naming'

// ---------------------------------------------------------------------------
// Enzymes
// ---------------------------------------------------------------------------

/** One enzyme: its site in upper-case IUPAC letters, and where in it the top strand is cut. */
export interface Enzyme {
  name: string
  site: string
  /** Site bases before the `^`: `0` for `^GATC`, `1` for `G^ANTC`, `4` for `CATG^`. */
  cut: number
}

/**
 * The presets, in the order the form lists them.
 *
 * The four-cutters Hi-C protocols use and the six-cutters of the first Hi-C
 * papers. Each site is checked against Biopython's `Bio.Restriction` by the
 * golden script, which digests the yeast reference with every one of them and
 * holds {@link cutsIn} to the answer.
 */
export const ENZYMES: readonly Enzyme[] = [
  { name: 'DpnII', site: 'GATC', cut: 0 },
  { name: 'HindIII', site: 'AAGCTT', cut: 1 },
  { name: 'NcoI', site: 'CCATGG', cut: 1 },
  { name: 'EcoRI', site: 'GAATTC', cut: 1 },
  { name: 'BglII', site: 'AGATCT', cut: 1 },
  { name: 'HinfI', site: 'GANTC', cut: 1 },
  { name: 'DdeI', site: 'CTNAG', cut: 1 },
  { name: 'MseI', site: 'TTAA', cut: 1 },
  { name: 'NlaIII', site: 'CATG', cut: 4 },
  { name: 'CviQI', site: 'GTAC', cut: 1 },
  { name: 'AluI', site: 'AGCT', cut: 2 },
]

/**
 * Other names for a preset: isoschizomers, which recognise the same site and
 * cut it in the same place, so a reader who used MboI gets DpnII's fragments
 * under the name they typed.
 */
export const ENZYME_ALIASES: Readonly<Record<string, string>> = {
  MboI: 'DpnII',
  Sau3AI: 'DpnII',
  Csp6I: 'CviQI',
}

/**
 * Kits that cut with more than one enzyme. Micro-C and Omni-C cut with a
 * nuclease rather than an enzyme and have no sites to list, so they are not
 * here: a library made with one asks for no enzyme.
 */
export const KITS: Readonly<Record<string, readonly string[]>> = {
  Arima: ['DpnII', 'HinfI'],
}

const BY_NAME = ((): Map<string, Enzyme> => {
  const out = new Map<string, Enzyme>()
  for (const enzyme of ENZYMES) out.set(enzyme.name.toLowerCase(), enzyme)
  for (const [alias, name] of Object.entries(ENZYME_ALIASES)) {
    const enzyme = out.get(name.toLowerCase())
    if (enzyme !== undefined) out.set(alias.toLowerCase(), enzyme)
  }
  return out
})()

/** A preset by its name or an alias, case ignored; `undefined` for one this does not know. */
export function enzymeByName(name: string): Enzyme | undefined {
  return BY_NAME.get(name.trim().toLowerCase())
}

/** A kit's name as {@link KITS} spells it, case ignored, or `undefined`. */
export function kitNamed(name: string): string | undefined {
  const wanted = name.trim().toLowerCase()
  return Object.keys(KITS).find((kit) => kit.toLowerCase() === wanted)
}

/** The site as it is written, with the `^`: `^GATC`, `G^ANTC`. */
export function siteText(enzyme: Enzyme): string {
  return `${enzyme.site.slice(0, enzyme.cut)}^${enzyme.site.slice(enzyme.cut)}`
}

/**
 * How far past the top-strand cut the bottom strand is cut, `L - 2k`: `4` for
 * DpnII, `3` for HinfI, `-4` for NlaIII, `0` for a blunt cutter such as AluI.
 */
export function bottomShift(enzyme: Enzyme): number {
  return enzyme.site.length - 2 * enzyme.cut
}

/**
 * The fewest sites per base a typed site may expect: a four-base cutter's.
 *
 * A guard on the shape of the request rather than a limit of the scan. `^GA`
 * cuts every sixteen bases or so, which on a mammalian reference is two hundred
 * million cuts and a lane nobody could draw — and it is never what a reader of a
 * Hi-C library meant. Every preset is at this bound or under it; a degenerate
 * position counts for what it permits, so `G^ANTC` is as specific as `^GATC`.
 */
const MOST_SPECIFIC_FREQUENCY = 1 / 256

/** How many enzymes one digest may name: a cut keeps which of them made it in a byte. */
const MOST_ENZYMES = 255

/** How often a compiled site is expected at a position of a uniform genome. */
function frequencyOf(motif: Motif): number {
  let frequency = 1
  for (const mask of motif) {
    let bases = 0
    for (let bit = mask; bit !== 0; bit &= bit - 1) bases++
    frequency *= bases / 4
  }
  return frequency
}

/** One typed site, or why it cannot be one. */
function parseSite(text: string): Enzyme | { refusal: string } {
  // `U` is `T`, as the matcher reads it, so the site is written in one alphabet.
  const upper = text.toUpperCase().replace(/U/g, 'T')
  const at = upper.indexOf('^')
  const letters = upper.replace('^', '')
  if (at < 0) {
    const compiled = compileMotif(letters)
    return {
      refusal: isMotifRefusal(compiled)
        ? `“${text}” is neither an enzyme this knows nor a site in IUPAC letters with a ^ where ` +
          'it cuts.'
        : `“${text}” needs a ^ where the enzyme cuts the top strand, as in ^GATC or G^ANTC.`,
    }
  }
  if (letters.includes('^')) {
    return { refusal: `“${text}” has more than one ^, and a site is cut in one place.` }
  }
  const compiled = compileMotif(letters)
  if (isMotifRefusal(compiled)) return { refusal: compiled.reason }
  if (frequencyOf(compiled) > MOST_SPECIFIC_FREQUENCY) {
    return {
      refusal:
        `“${text}” would cut every ${Math.round(1 / frequencyOf(compiled))} bases or so; a site ` +
        'needs at least the specificity of a four-base cutter.',
    }
  }
  return { name: `${upper.slice(0, at)}^${upper.slice(at + 1)}`, site: letters, cut: at }
}

/**
 * The enzyme a name stands for — a preset, an alias, or a typed site written
 * with its `^` — or `undefined`. How {@link cutsOfResult} reads the name each
 * cut of a run carries.
 */
export function enzymeNamed(name: string): Enzyme | undefined {
  const preset = enzymeByName(name)
  if (preset !== undefined) return preset
  const site = parseSite(name)
  return 'refusal' in site ? undefined : site
}

/**
 * The enzymes a form's two answers name, or why they name none that can run.
 *
 * `choice` is the `enzyme` control's value: `none` (no restriction step, so no
 * enzymes and no refusal), a preset's name, a kit's, or `custom`, which reads
 * `sites` — a list separated by commas or spaces, each item a preset's name or
 * alias, a kit's, or a site with one `^`. The same enzyme named twice is cut
 * once, so `DpnII, MboI` is DpnII's fragments rather than each cut counted
 * twice.
 */
export function enzymesFor(choice: string, sites: string): Enzyme[] | { refusal: string } {
  const value = choice.trim()
  if (value === '' || value === 'none') return []
  if (value !== 'custom') {
    const kit = kitNamed(value)
    if (kit !== undefined) return KITS[kit].map((name) => enzymeByName(name) as Enzyme)
    const enzyme = enzymeByName(value)
    return enzyme === undefined
      ? { refusal: `“${value}” is not an enzyme or a kit this knows. Pick one, or type its site under custom.` }
      : [enzyme]
  }
  const items = sites.split(/[\s,;]+/).filter((item) => item !== '')
  if (items.length === 0) return { refusal: 'Type an enzyme or a site, such as DpnII or G^ANTC.' }
  const out: Enzyme[] = []
  const seen = new Set<string>()
  const keep = (enzyme: Enzyme): void => {
    const key = `${enzyme.site}^${enzyme.cut}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(enzyme)
  }
  for (const item of items) {
    const kit = kitNamed(item)
    if (kit !== undefined) {
      for (const name of KITS[kit]) keep(enzymeByName(name) as Enzyme)
      continue
    }
    const named = enzymeByName(item)
    if (named !== undefined) {
      keep(named)
      continue
    }
    const site = parseSite(item)
    if ('refusal' in site) return site
    keep(site)
  }
  if (out.length > MOST_ENZYMES) {
    return { refusal: `That is ${out.length} enzymes, and one digest takes ${MOST_ENZYMES} at most.` }
  }
  return out
}

/** What a set of enzymes is called: `DpnII`, `DpnII+HinfI`, `G^ANTC`. */
export function enzymeLabel(enzymes: readonly Enzyme[]): string {
  return enzymes.map((enzyme) => enzyme.name).join('+')
}

/** The longest site of a set, less one: what a piece of a reference must overlap the next by. */
export function siteOverlap(enzymes: readonly Enzyme[]): number {
  let longest = 0
  for (const enzyme of enzymes) longest = Math.max(longest, enzyme.site.length)
  return Math.max(0, longest - 1)
}

// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------

/**
 * The cuts of one piece or one sequence, three parallel arrays in the order of
 * the top-strand cut.
 *
 * `top` is ascending and unique. Where two enzymes of one digest cut the top
 * strand at one position, the first of them in the list is the one kept — on
 * every real pair of sites that happens on, their bottom cuts agree too.
 */
export interface CutSites {
  /** The top-strand cut `c` of each site: the first base after it, 0-based. */
  top: Int32Array
  /** The bottom-strand cut `c'` of the same site, in top-strand coordinates. */
  bottom: Int32Array
  /**
   * Which enzyme of the digest made each cut, as a small index: its place in
   * the list {@link cutsIn} was given, or, read back by {@link cutsOfResult},
   * the order the enzymes' names first appear in.
   */
  enzyme: Uint8Array
}

/** One enzyme compiled once, however many pieces of however many sequences it is run over. */
interface Compiled {
  motif: Motif
  /** Added to a match's start, on either strand, for the top-strand cut: `k`. */
  offset: number
}

const COMPILED = new Map<string, Compiled>()

function compiledOf(enzyme: Enzyme): Compiled {
  const key = `${enzyme.site}^${enzyme.cut}`
  const held = COMPILED.get(key)
  if (held !== undefined) return held
  const motif = compileMotif(enzyme.site)
  if (isMotifRefusal(motif)) throw new Error(`${enzyme.name}: ${motif.reason}`)
  const made = { motif, offset: enzyme.cut }
  COMPILED.set(key, made)
  return made
}

/**
 * A cut and the enzyme that made it, as one number that sorts by the cut: the
 * cut times 256 plus the enzyme's position, exact in a double for any cut a
 * 32-bit coordinate can hold. One typed array, sorted once, rather than three
 * kept in step by hand.
 */
const ENZYME_SLOTS = 256

/**
 * Sort `keys[0, n)`, keep the first of each top-strand cut, and lay them out
 * as {@link CutSites}, dropping a cut outside `(lo, hi)`.
 */
function unpack(keys: Float64Array, n: number, shifts: Int32Array, lo: number, hi: number): CutSites {
  const view = keys.subarray(0, n).sort()
  let kept = 0
  let last = Number.NaN
  for (let i = 0; i < view.length; i++) {
    const top = Math.floor(view[i] / ENZYME_SLOTS)
    if (top === last || !(top > lo && top < hi)) continue
    last = top
    view[kept++] = view[i]
  }
  const out: CutSites = {
    top: new Int32Array(kept),
    bottom: new Int32Array(kept),
    enzyme: new Uint8Array(kept),
  }
  for (let i = 0; i < kept; i++) {
    const top = Math.floor(view[i] / ENZYME_SLOTS)
    const enzyme = view[i] - top * ENZYME_SLOTS
    out.top[i] = top
    out.bottom[i] = top + shifts[enzyme]
    out.enzyme[i] = enzyme
  }
  return out
}

/**
 * Every cut the enzymes make in one piece of a sequence, in the order of the
 * top-strand cut and unique by it, with `offset` added so the positions are the
 * sequence's.
 *
 * Both strands are searched, and a palindrome — every preset — once
 * (`findMotif`'s rule), so a site gives one cut. Several enzymes are merged: a
 * position two of them cut is one boundary, which is what a fragment BED made
 * from both digests says.
 *
 * Nothing is dropped for lying at an end, because a piece does not know where
 * its sequence ends: {@link contigCuts} drops a cut at the sequence's first
 * base or at its end. A caller reading a reference in pieces overlaps each with
 * the next by {@link siteOverlap} and merges them with {@link contigCuts}, which
 * finds every site exactly once whatever the seams.
 */
export function cutsIn(bases: Uint8Array, enzymes: readonly Enzyme[], offset = 0): CutSites {
  let keys = new Float64Array(Math.max(16, bases.length >> 7))
  let n = 0
  enzymes.forEach((enzyme, at) => {
    const compiled = compiledOf(enzyme)
    const { hits } = findMotif(bases, compiled.motif, { bothStrands: true, offset })
    if (n + hits.length > keys.length) {
      const grown = new Float64Array(Math.max(keys.length * 2, n + hits.length))
      grown.set(keys.subarray(0, n))
      keys = grown
    }
    // `s + k` on either strand: a reverse match is cut where a forward one is
    // (the module docstring), so the strand the site was read on is not asked.
    for (const hit of hits) keys[n++] = (hit.start + compiled.offset) * ENZYME_SLOTS + at
  })
  const shifts = Int32Array.from(enzymes, bottomShift)
  return unpack(keys, n, shifts, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY)
}

/**
 * One sequence's cuts, from the pieces it was read in: merged, de-duplicated,
 * and without a cut whose top strand is cut at `0` or at `length` or past it,
 * which would be a fragment of no bases.
 *
 * A site lying wholly inside the overlap of two pieces is found by both, and
 * its cut can fall on either side of the seam, so the pieces are merged by
 * sorting rather than by appending.
 */
export function contigCuts(pieces: readonly CutSites[], length: number): CutSites {
  let total = 0
  for (const piece of pieces) total += piece.top.length
  const keys = new Float64Array(total)
  const shifts = new Int32Array(ENZYME_SLOTS)
  let n = 0
  for (const piece of pieces) {
    for (let i = 0; i < piece.top.length; i++) {
      keys[n++] = piece.top[i] * ENZYME_SLOTS + piece.enzyme[i]
      shifts[piece.enzyme[i]] = piece.bottom[i] - piece.top[i]
    }
  }
  return unpack(keys, n, shifts, 0, length)
}

/**
 * `[0, …cuts, length]`: one strand's fragment boundaries, from its cuts in the
 * order of the top-strand cut — {@link CutSites.top} for `B`,
 * {@link CutSites.bottom} for `B'`.
 *
 * Nothing is dropped, so the two arrays a sequence's cuts give are the same
 * length and fragment `i` is one fragment in both. Each boundary is kept at or
 * after the one before and inside `[0, length]`: the top cuts already are, and
 * so are the bottom cuts of one enzyme or of a kit, but two typed sites whose
 * overhangs run in opposite directions can put one bottom cut before its
 * neighbour's, and a fragment cannot end before it starts.
 */
export function boundaries(cuts: Int32Array, length: number): Int32Array {
  const out = new Int32Array(cuts.length + 2)
  let last = 0
  for (let i = 0; i < cuts.length; i++) {
    last = Math.min(length, Math.max(last, cuts[i]))
    out[i + 1] = last
  }
  out[cuts.length + 1] = length
  return out
}

/**
 * The fragment a 0-based position lies in: `searchsorted(bounds, x, 'right') - 1`,
 * clamped to `[0, fragments - 1]`, for the boundaries of the strand the end
 * was read on — `B` for a `+` end, `B'` for a `-` one.
 *
 * The clamp is `pairtools restrict`'s (`find_rfrag`), checked rather than
 * assumed: inside the sequence the two rules are one, and outside it pairtools
 * puts a position before the start in the first fragment and one at the end or
 * past it in the last, where an unclamped search would name a fragment that
 * does not exist.
 */
export function fragmentOf(bounds: Int32Array, x: number): number {
  // The last boundary at or below x, by halving a window that starts at it:
  // a step is taken or not by a comparison rather than a branch, which on a
  // `.pairs` whose ends land anywhere is most of what the search costs.
  let lo = 0
  let n = bounds.length
  while (n > 1) {
    const half = n >> 1
    lo = bounds[lo + half] <= x ? lo + half : lo
    n -= half
  }
  return Math.min(lo, Math.max(0, bounds.length - 2))
}

// ---------------------------------------------------------------------------
// Pairs
// ---------------------------------------------------------------------------

/** What a pair is, read against the fragments its ends lie in. */
export type PairClass = 'trans' | 'dangling' | 'self-circle' | 'same-strand' | 're-ligation' | 'valid'

/** Every class, in the order a table and a legend list them. */
export const PAIR_CLASSES: readonly PairClass[] = [
  'valid',
  're-ligation',
  'dangling',
  'self-circle',
  'same-strand',
  'trans',
]

/** The strand pair of two ends, as a table's column says it. */
export type Orientation = '++' | '+-' | '-+' | '--'

export const ORIENTATIONS: readonly Orientation[] = ['++', '+-', '-+', '--']

/**
 * The class of a pair, from the fragments its two ends lie in — each placed
 * by its own strand's cut ({@link fragmentOf}) — and their strands; `a` is the
 * end with the smaller position, and `cis` false makes it `trans` whatever the
 * rest says.
 *
 * - The same fragment, read towards each other (`+ -`): **dangling**, an end
 *   that was never cut or never ligated.
 * - The same fragment, read away from each other (`- +`): **self-circle**, a
 *   fragment ligated to itself.
 * - The same fragment on one strand (`+ +`, `- -`): **same-strand**.
 * - Neighbouring fragments read towards each other: **re-ligation**, two
 *   neighbours joined back where they were cut.
 * - Anything else: **valid**.
 */
export function classify(
  cis: boolean,
  fragA: number,
  strandA: string,
  fragB: number,
  strandB: string,
): PairClass {
  if (!cis) return 'trans'
  if (fragA === fragB) {
    if (strandA === strandB) return 'same-strand'
    return strandA === '+' ? 'dangling' : 'self-circle'
  }
  return Math.abs(fragB - fragA) === 1 && strandA === '+' && strandB === '-' ? 're-ligation' : 'valid'
}

/** The classes' positions in {@link PAIR_CLASSES}, which is what the counter keys its counts on. */
const VALID = 0
const RELIGATION = 1
const DANGLING = 2
const SELF_CIRCLE = 3
const SAME_STRAND = 4
const TRANS = 5

/**
 * {@link classify} on strand codes — `0` is `+`, `1` is `-` — for a cis pair,
 * as a position in {@link PAIR_CLASSES}: the same rules, with no string made.
 */
function classCode(fragA: number, strandA: number, fragB: number, strandB: number): number {
  if (fragA === fragB) {
    if (strandA === strandB) return SAME_STRAND
    return strandA === 0 ? DANGLING : SELF_CIRCLE
  }
  return Math.abs(fragB - fragA) === 1 && strandA === 0 && strandB === 1 ? RELIGATION : VALID
}

/** Everything a {@link RestrictionCounter} counts, as plain data that crosses a worker. */
export interface RestrictionStats {
  /** {@link enzymeLabel} of the enzymes the cuts came from. */
  enzymes: string
  /** Pairs classified: both ends mapped, on sequences of the reference, not duplicates. */
  counted: number
  /** Pairs that would have counted but have an end on a sequence the reference has not got. */
  unassigned: number
  classes: Record<PairClass, number>
  /**
   * Each class by the strands of its two ends: `a` then `b` for a cis pair,
   * ordered by position, and the file's order for a trans one.
   */
  byOrientation: Record<PairClass, Record<Orientation, number>>
  /** `distEdges()`: the left edge of every distance bin. */
  distanceEdges: number[]
  /** Ends per distance bin, by the end's strand. */
  distance: { '+': number[]; '-': number[] }
  fragments: {
    /** Fragments on the reference's sequences. */
    total: number
    /** Of them, the ones at least one counted end lies in. */
    seen: number
    /** `0`, `1`, `2`, `3–4`, `5–8`, … through the last bin with a fragment in it. */
    binLabels: string[]
    /** Fragments per bin of {@link binLabels}: how many ends each fragment holds. */
    counts: number[]
  }
}

/**
 * Distances below this are binned by a table rather than a search: most of a
 * four-cutter's fragments are shorter, and it is 64 kB once per counter.
 */
const DIRECT_DISTANCES = 1 << 16

/** `0` for `+`, `1` for `-`, `-1` for anything else — which is an end not mapped. */
function strandCode(strand: string): number {
  return strand === '+' ? 0 : strand === '-' ? 1 : -1
}

/** The bin of the ends-per-fragment histogram a count falls in: `0`, `1`, `2`, `3–4`, `5–8`, …. */
function endsBin(count: number): number {
  return count === 0 ? 0 : 33 - Math.clz32(count - 1)
}

function endsBinLabel(bin: number): string {
  if (bin <= 2) return String(bin)
  const hi = 2 ** (bin - 1)
  return `${hi / 2 + 1}–${hi}`
}

/**
 * The restriction-fragment statistics of a `.pairs`, one record at a time.
 *
 * Built once from the cuts of the reference — {@link cutsOfResult} rebuilds them
 * from a `restriction` run — and the lengths of its sequences; then
 * {@link add} per record and {@link result} once. The sequences of `cuts` are
 * the reference: each one with a length in `lengths` is cut into its fragments,
 * one with no cuts is one fragment, and a pair with an end anywhere else is
 * {@link RestrictionStats.unassigned}.
 *
 * **Names are matched as everywhere else (§5.9).** The cuts are in the
 * reference's spelling and a `.pairs` writes its own, so a name that is not one
 * of the reference's is looked up once through `contigIndexOf`'s ladder — `I`
 * finds `chrI` — and the answer is kept, so a file of twenty million records
 * pays for each distinct spelling once. `lengths` is read the same way, so it
 * may be the `.pairs` header's or the map's.
 *
 * **Nothing is allocated per record.** The counts are typed arrays sized at
 * construction, the strands are compared rather than concatenated, and the last
 * name seen on each side is remembered, since a sorted `.pairs` repeats the
 * same pair of chromosomes for millions of lines.
 */
export class RestrictionCounter {
  private readonly names: string[] = []
  /** `B` and `B'` per sequence. */
  private readonly top: Int32Array[] = []
  private readonly bottom: Int32Array[] = []
  /** Where each sequence's fragments start in {@link ends}. */
  private readonly firstFragment: number[] = []
  private readonly index = new Map<string, number>()
  private readonly ends: Uint32Array
  private readonly classCounts = new Float64Array(PAIR_CLASSES.length * ORIENTATIONS.length)
  private readonly edges = distEdges()
  private readonly plus: Float64Array
  private readonly minus: Float64Array
  private counted = 0
  private unassigned = 0
  private last1 = ''
  private lastAt1 = -1
  private last2 = ''
  private lastAt2 = -1
  /**
   * The sequence and the fragment the last end on each side fell in. A sorted
   * `.pairs` walks the first end along a chromosome, so the next one is
   * usually in the same fragment — on either strand, since fragment `i` is one
   * fragment in both — and asking that first saves the search.
   */
  private nearContig1 = -1
  private nearAt1 = 0
  private nearContig2 = -1
  private nearAt2 = 0
  /** The distance bin of every distance below {@link DIRECT_DISTANCES}, looked up rather than searched. */
  private readonly distanceBin: Uint8Array

  constructor(
    cuts: ReadonlyMap<string, CutSites>,
    lengths: ReadonlyMap<string, number>,
    private readonly label = '',
  ) {
    const lengthNames = [...lengths.keys()]
    let fragments = 0
    for (const [name, sites] of cuts) {
      let length = lengths.get(name)
      if (length === undefined) {
        const at = contigIndexOf(lengthNames, name)
        length = at < 0 ? undefined : lengths.get(lengthNames[at])
      }
      // A sequence whose length nobody gave cannot be cut into fragments — its
      // last one has no end — so it is not part of the reference this counts
      // against, and its pairs are unassigned rather than guessed at.
      if (length === undefined || !(length > 0) || this.index.has(name)) continue
      const top = boundaries(sites.top, length)
      this.index.set(name, this.names.length)
      this.names.push(name)
      this.top.push(top)
      this.bottom.push(boundaries(sites.bottom, length))
      this.firstFragment.push(fragments)
      fragments += top.length - 1
    }
    this.ends = new Uint32Array(fragments)
    this.plus = new Float64Array(this.edges.length)
    this.minus = new Float64Array(this.edges.length)
    this.distanceBin = new Uint8Array(DIRECT_DISTANCES)
    for (let d = 0, bin = 0; d < DIRECT_DISTANCES; d++) {
      while (bin + 1 < this.edges.length && this.edges[bin + 1] <= d) bin++
      this.distanceBin[d] = bin
    }
  }

  /** A sequence's index among the reference's, or `-1`; resolved once per spelling. */
  private indexOf(name: string): number {
    const held = this.index.get(name)
    if (held !== undefined) return held
    const at = contigIndexOf(this.names, name)
    this.index.set(name, at)
    return at
  }

  /**
   * One record: both ends as the file writes them, `pos` 1-based, and whether
   * the record is a duplicate (`pair_type` `DD`).
   *
   * An end on `!`, or with a strand other than `+` or `-`, is unmapped and the
   * pair is not counted; nor is a duplicate. A mapped pair with an end on a
   * sequence the reference has not got is {@link RestrictionStats.unassigned}.
   */
  add(
    chrom1: string,
    pos1: number,
    strand1: string,
    chrom2: string,
    pos2: number,
    strand2: string,
    duplicate: boolean,
  ): void {
    if (duplicate) return
    const s1 = strandCode(strand1)
    const s2 = strandCode(strand2)
    if (s1 < 0 || s2 < 0 || chrom1 === '!' || chrom2 === '!') return
    // A position that is not a number is a record nobody can place.
    if (!(pos1 === pos1) || !(pos2 === pos2)) return
    let c1: number
    if (chrom1 === this.last1) c1 = this.lastAt1
    else {
      c1 = this.indexOf(chrom1)
      this.last1 = chrom1
      this.lastAt1 = c1
    }
    let c2: number
    if (chrom2 === this.last2) c2 = this.lastAt2
    else {
      c2 = this.indexOf(chrom2)
      this.last2 = chrom2
      this.lastAt2 = c2
    }
    if (c1 < 0 || c2 < 0) {
      this.unassigned++
      return
    }
    this.counted++

    const x1 = pos1 - 1
    const x2 = pos2 - 1
    // Each end by its own strand's cut: a `-` read starts on the bottom strand.
    // The fragment the last end on this side fell in is tried first: if `x` is
    // inside it, it is the last boundary at or below `x`, which is the answer.
    const b1 = s1 === 0 ? this.top[c1] : this.bottom[c1]
    let f1 = this.nearAt1
    if (c1 !== this.nearContig1 || !(x1 >= b1[f1] && x1 < b1[f1 + 1])) {
      f1 = fragmentOf(b1, x1)
      this.nearContig1 = c1
      this.nearAt1 = f1
    }
    const b2 = s2 === 0 ? this.top[c2] : this.bottom[c2]
    let f2 = this.nearAt2
    if (c2 !== this.nearContig2 || !(x2 >= b2[f2] && x2 < b2[f2 + 1])) {
      f2 = fragmentOf(b2, x2)
      this.nearContig2 = c2
      this.nearAt2 = f2
    }
    this.ends[this.firstFragment[c1] + f1]++
    this.ends[this.firstFragment[c2] + f2]++
    this.distanceOf(c1, f1, x1, s1)
    this.distanceOf(c2, f2, x2, s2)

    let code: number
    let orientation: number
    if (c1 !== c2) {
      code = TRANS
      orientation = s1 * 2 + s2
    } else if (x2 < x1) {
      code = classCode(f2, s2, f1, s1)
      orientation = s2 * 2 + s1
    } else {
      code = classCode(f1, s1, f2, s2)
      orientation = s1 * 2 + s2
    }
    this.classCounts[code * ORIENTATIONS.length + orientation]++
  }

  /**
   * One end's distance to the next cut in the direction it reads, on its own
   * strand's boundaries: `B[i+1] - x` on `+`, `x - B'[i] + 1` on `-`, so `1` is
   * an end whose 5′ base is the last before the cut, and the two reads of a
   * dangling end both give the fragment's length. An end placed outside its
   * sequence lands in the first bin rather than nowhere.
   */
  private distanceOf(contig: number, fragment: number, x: number, strand: number): void {
    const d = strand === 0 ? this.top[contig][fragment + 1] - x : x - this.bottom[contig][fragment] + 1
    let lo = 0
    if (d >= 0 && d < DIRECT_DISTANCES) lo = this.distanceBin[d]
    else if (d > 0) {
      // `searchsorted(edges, d, 'right') - 1`, for a fragment longer than the table.
      const edges = this.edges
      let hi = edges.length
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (edges[mid] <= d) lo = mid
        else hi = mid
      }
    }
    if (strand === 0) this.plus[lo]++
    else this.minus[lo]++
  }

  /** Everything counted, as plain data. */
  result(): RestrictionStats {
    const classes = {} as Record<PairClass, number>
    const byOrientation = {} as Record<PairClass, Record<Orientation, number>>
    PAIR_CLASSES.forEach((name, code) => {
      const row = {} as Record<Orientation, number>
      let sum = 0
      ORIENTATIONS.forEach((orientation, at) => {
        const count = this.classCounts[code * ORIENTATIONS.length + at]
        row[orientation] = count
        sum += count
      })
      classes[name] = sum
      byOrientation[name] = row
    })

    const histogram: number[] = []
    let seen = 0
    for (let f = 0; f < this.ends.length; f++) {
      const count = this.ends[f]
      if (count > 0) seen++
      const bin = endsBin(count)
      while (histogram.length <= bin) histogram.push(0)
      histogram[bin]++
    }
    return {
      enzymes: this.label,
      counted: this.counted,
      unassigned: this.unassigned,
      classes,
      byOrientation,
      distanceEdges: [...this.edges],
      distance: { '+': Array.from(this.plus), '-': Array.from(this.minus) },
      fragments: {
        total: this.ends.length,
        seen,
        binLabels: histogram.map((_, bin) => endsBinLabel(bin)),
        counts: histogram,
      },
    }
  }
}

// ---------------------------------------------------------------------------
// A `restriction` run, read back
// ---------------------------------------------------------------------------

/**
 * The cuts a `restriction` task result holds, by sequence and on both strands,
 * or `null` for a result with no sites output.
 *
 * Read from its intervals output, whose every interval is one cut: `start` is
 * the top-strand cut — the first base after it — and the interval is that one
 * base; `name` is the enzyme that made it, a preset's name or a typed site
 * with its `^`, which is what gives the bottom-strand cut back
 * ({@link bottomShift}). A kit's cuts are two enzymes' with two shifts, so the
 * name is per cut rather than per run. Every sequence the run cut is listed in
 * the set's `contigs`, a sequence with no cut among them, so a sequence missing
 * from the map is one the run did not read rather than one with no sites.
 */
export function cutsOfResult(result: TaskResult): Map<string, CutSites> | null {
  const output = result.outputs.find(
    (one): one is IntervalsOutput =>
      one.kind === 'intervals' && one.id.startsWith('restriction-') && one.payload.kind === 'features',
  )
  if (output === undefined || output.payload.kind !== 'features') return null
  const set = output.payload.data
  const out = new Map<string, CutSites>()
  // One shift per distinct name: a run names its cuts with a handful of strings.
  const shifts = new Map<string, number>()
  const slots = new Map<string, number>()
  for (let c = 0; c < set.contigs.length; c++) {
    const from = set.contigAt[c] ?? 0
    const to = set.contigAt[c + 1] ?? from
    const top = set.start.slice(from, to)
    const bottom = new Int32Array(top.length)
    const enzyme = new Uint8Array(top.length)
    for (let i = 0; i < top.length; i++) {
      const name = set.name[from + i] ?? ''
      let shift = shifts.get(name)
      if (shift === undefined) {
        const known = enzymeNamed(name)
        // A name this build cannot read is placed by its top cut on both
        // strands, which is the reading every blunt cutter has anyway.
        shift = known === undefined ? 0 : bottomShift(known)
        shifts.set(name, shift)
        slots.set(name, Math.min(ENZYME_SLOTS - 1, slots.size))
      }
      bottom[i] = top[i] + shift
      enzyme[i] = slots.get(name) ?? 0
    }
    out.set(set.contigs[c], { top, bottom, enzyme })
  }
  return out
}
