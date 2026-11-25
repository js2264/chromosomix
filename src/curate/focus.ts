/**
 * The close-up's picture (SPECS §33.3): the contacts among a few genomes'
 * contigs as a map with one cell a contig, built from the contig network the
 * worker holds — never from the file's picture, whose cells are sums over bins
 * (a contig shorter than a cell reads faint) of raw counts (an abundant
 * organism reads bright).
 *
 * A cell is the pair's contacts over what their visibilities expect, `c·T/(tᵢ·tⱼ)`
 * — the scale the method's affinity is on, where two contigs of one organism
 * meet at about their genome's density and two strangers at the background. A
 * contig with itself is its own density, `2·w·T/t²`, bright as a diagonal is.
 *
 * As the file's picture is: a byte a cell over an upper triangle, a pyramid of
 * means over it, so `edit/paint.ts` draws it as it is; the numbers a readout
 * shows come from the contacts the answer also carries, never from a byte.
 */

import { encode, pyramid, triangleIndex, triangleSize, type PictureLevel, type Quantizer } from '../metacooler/picture'

/** The most contigs a close-up's picture holds: a triangle of 33 MB. */
export const FOCUS_PICTURE_CAP = 8192

/** The close-up's picture: its levels, what a byte means, and the range it opens at. */
export interface FocusPicture {
  levels: PictureLevel[]
  /** What bytes `1` and `255` stand for, as base-10 logs. */
  low: number
  high: number
  /** The range it opens at, as base-10 logs: the background to the densest pairs. */
  vmin: number
  vmax: number
}

/** The contacts among `n` contigs, as the worker answers them. */
export interface FocusContacts {
  /** Pairs `i < j` of indices into the contigs asked. */
  i: ArrayLike<number>
  j: ArrayLike<number>
  contacts: ArrayLike<number>
  /** Each contig's contacts within itself. */
  within: ArrayLike<number>
  /** Each contig's visibility, its contacts with every other contig. */
  visibility: ArrayLike<number>
  /** Every contig's visibility summed: the network's `T`. */
  total: number
}

/** The ratio a pair's cell shows: observed over expected by visibility; `0` where nothing is expected. */
export function pairRatio(contacts: number, ta: number, tb: number, total: number): number {
  return ta > 0 && tb > 0 ? (contacts * total) / (ta * tb) : 0
}

/** The ratio a contig's own cell shows: its density. */
export function ownRatio(within: number, t: number, total: number): number {
  if (!(within > 0)) return 0
  return t > 0 ? (2 * within * total) / (t * t) : Number.POSITIVE_INFINITY
}

/**
 * The picture of `n` contigs' contacts, in the order asked; `null` past
 * {@link FOCUS_PICTURE_CAP} contigs.
 *
 * @param background The network's background ratio (the method's `ρ`): the
 *   colour scale opens there, so noise is near the scale's foot.
 */
export function focusPicture(n: number, contacts: FocusContacts, background: number): FocusPicture | null {
  if (n > FOCUS_PICTURE_CAP || n === 0) return null
  const { total, visibility: t } = contacts
  // The range a byte spans: from a decade under the faintest pair to half a
  // decade over the densest, the diagonal clamped above it.
  let least = Number.POSITIVE_INFINITY
  let most = 0
  for (let k = 0; k < contacts.i.length; k++) {
    const v = pairRatio(contacts.contacts[k], t[contacts.i[k]], t[contacts.j[k]], total)
    if (v > 0) {
      if (v < least) least = v
      if (v > most) most = v
    }
  }
  const floor = background > 0 ? background : 1e-3
  if (!(most > 0)) {
    least = floor
    most = floor * 1000
  }
  const low = Math.floor(Math.log10(Math.min(least, floor))) - 1
  const high = Math.max(Math.log10(most) + 0.5, low + 1)
  const q: Quantizer = { low, high }
  const cells = new Uint8Array(triangleSize(n))
  const histogram = new Float64Array(256)
  for (let k = 0; k < contacts.i.length; k++) {
    const a = contacts.i[k]
    const b = contacts.j[k]
    const byte = encode(pairRatio(contacts.contacts[k], t[a], t[b], total), q)
    cells[a <= b ? triangleIndex(a, b, n) : triangleIndex(b, a, n)] = byte
    histogram[byte]++
  }
  for (let a = 0; a < n; a++) {
    const own = ownRatio(contacts.within[a], t[a], total)
    cells[triangleIndex(a, a, n)] = own === Number.POSITIVE_INFINITY ? 255 : encode(own, q)
  }
  // Opens at the background, and at the densest pairs but a hundredth.
  const vmin = Math.max(low, Math.log10(floor))
  let vmax = percentileLog(histogram, q, 0.99)
  if (!(vmax > vmin + 0.5)) vmax = vmin + Math.max(1, high - vmin)
  return { levels: pyramid({ n, cells }, q), low, high, vmin, vmax }
}

/** The base-10 log at a fraction of the cells a histogram of bytes counts. */
function percentileLog(histogram: Float64Array, q: Quantizer, fraction: number): number {
  let filled = 0
  for (let b = 1; b < 256; b++) filled += histogram[b]
  if (filled === 0) return q.high
  const target = filled * fraction
  let running = 0
  for (let b = 1; b < 256; b++) {
    running += histogram[b]
    if (running >= target) return q.low + ((b - 1) * (q.high - q.low)) / 254
  }
  return q.high
}

/**
 * A pair's contacts from a close-up's answer, `0` for none: a binary search in
 * the answer's pairs, sorted by `i` then `j`, so a readout never reads a byte.
 */
export function focusContactsOf(contacts: FocusContacts, a: number, b: number): number {
  if (a === b) return contacts.within[a] ?? 0
  const i = Math.min(a, b)
  const j = Math.max(a, b)
  let lo = 0
  let hi = contacts.i.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const mi = contacts.i[mid]
    const mj = contacts.j[mid]
    if (mi < i || (mi === i && mj < j)) lo = mid + 1
    else hi = mid
  }
  return lo < contacts.i.length && contacts.i[lo] === i && contacts.j[lo] === j ? contacts.contacts[lo] : 0
}
