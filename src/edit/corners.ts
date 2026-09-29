/**
 * The corner detector (SPECS §27.5): where two ends meet off the diagonal — the
 * corner of a block of contacts that stops — found over the whole map at once.
 *
 * A point `(p, q)` off the diagonal has four quadrants around it, and each is a
 * hypothesis about which two ends meet there: the rows just before `p` with the
 * columns just before `q` is the sequence left of `p` meeting the sequence left
 * of `q` — one arm of the bow-tie a turned stretch draws — and so on round. A
 * corner is a point where one quadrant stands out of the two it shares a side
 * with: the map there, over what it is expected to hold, far brighter than just
 * across either edge. A Harris corner for contact maps, on the coarse grid the
 * pass kept, from two integral images so every quadrant is four reads.
 *
 * It runs **once per file, in the file's own order**, in the reader's worker
 * beside the picture: a corner is a fact about two places in the file, and an
 * edit only moves where it is drawn. What it finds is a list of candidates, never
 * a verdict — `suggest.ts` scores every one of them exactly, through the edit as
 * it stands, and most of what a detector of this kind lights (a domain's corner,
 * a loop, centromeres clustering) scores far below two ends that truly meet.
 */

import { triangleIndex, type PictureContacts } from '../metacooler/picture'
import { EditedMap, junctionsAlong, type AxisStretch, type Expected } from './method'

/** A corner in the file's own order: two points, as edges of the picture's cells, and the quadrant. */
export interface FileCorner {
  /** The row's point and the column's, `row < col`. */
  row: number
  col: number
  /** Which side of each point the quadrant lies: `-1` before it, `1` after it. */
  rowSide: 1 | -1
  colSide: 1 | -1
  /** How far the quadrant stands above the brighter of its two neighbours, in natural logs of observed over expected. */
  strength: number
}

/** Coarse cells a quadrant is a side. */
const QUADRANT = 4
/** The least a quadrant must stand above its neighbours, and above what is expected: three times, in logs. */
const STANDOUT = Math.log(3)
/** The most corners kept, the strongest first. */
const MOST = 240

/**
 * Every corner of the map worth scoring, strongest first, each placed at the
 * picture's cells: the coarse point, moved to the most refused junction within a
 * coarse cell of it where there is one, else to a sequence's end there.
 */
export function findCorners(contacts: PictureContacts, expected: Expected): FileCorner[] {
  const { coarse, n, sequenceOf } = contacts
  const nc = coarse.n
  const f = coarse.factor
  if (nc < 2 * QUADRANT + 1) return []

  // Each coarse cell's sequence and coverage, and where it starts on the picture's grid.
  const firstCell = new Int32Array(nc + 1).fill(n)
  const coarseSequence = new Int32Array(nc)
  const coarseBias = new Float64Array(nc)
  const counted = new Float64Array(nc)
  for (let a = n - 1; a >= 0; a--) {
    const c = coarse.of[a]
    firstCell[c] = a
    coarseSequence[c] = sequenceOf[a]
    const b = expected.bias[a]
    if (b > 0) {
      coarseBias[c] += b
      counted[c]++
    }
  }
  firstCell[nc] = n
  for (let c = 0; c < nc; c++) coarseBias[c] = counted[c] > 0 ? coarseBias[c] / counted[c] : Number.NaN

  // Observed over expected, as a smoothed log — an empty cell a third, a cell
  // at expectation nothing, ten times it about two — summed into integral
  // images of the whole square, with a count beside it for the cells that hold
  // anything.
  const side = nc + 1
  const sums = new Float64Array(side * side)
  const counts = new Int32Array(side * side)
  for (let a = 0; a < nc; a++) {
    let rowSum = 0
    let rowCount = 0
    for (let b = 0; b < nc; b++) {
      const lo = a < b ? a : b
      const hi = a < b ? b : a
      const v = coarse.values[triangleIndex(lo, hi, nc)] / (coarseBias[lo] * coarseBias[hi])
      if (v >= 0 && lo !== hi) {
        const e = coarseSequence[lo] === coarseSequence[hi] ? expected.law[Math.min(n, (hi - lo) * f)] : expected.trans
        rowSum += Math.log((v + 0.5 * e) / (1.5 * e))
        rowCount++
      }
      const at = (a + 1) * side + (b + 1)
      sums[at] = sums[at - side] + rowSum
      counts[at] = counts[at - side] + rowCount
    }
  }
  const mean = (r0: number, r1: number, c0: number, c1: number): number => {
    if (r0 < 0 || c0 < 0 || r1 > nc || c1 > nc || r1 <= r0 || c1 <= c0) return Number.NaN
    const count = counts[r1 * side + c1] - counts[r0 * side + c1] - counts[r1 * side + c0] + counts[r0 * side + c0]
    if (count < 4) return Number.NaN
    const sum = sums[r1 * side + c1] - sums[r0 * side + c1] - sums[r1 * side + c0] + sums[r0 * side + c0]
    return sum / count
  }

  // Every point off the diagonal, each quadrant against its two neighbours.
  const w = QUADRANT
  const found: Array<{ p: number; q: number; rowSide: 1 | -1; colSide: 1 | -1; strength: number }> = []
  const orZero = (value: number): number => (Number.isNaN(value) ? 0 : value)
  for (let p = 1; p < nc; p++) {
    for (let q = p + 1; q < nc; q++) {
      // Far enough from the diagonal that no quadrant touches it.
      if (coarseSequence[p] === coarseSequence[q - 1] && q - p < 2 * w) continue
      const ll = mean(p - w, p, q - w, q)
      const rr = mean(p, p + w, q, q + w)
      const lr = mean(p - w, p, q, q + w)
      const rl = mean(p, p + w, q - w, q)
      const quadrants: Array<[number, number, number, 1 | -1, 1 | -1]> = [
        [ll, lr, rl, -1, -1],
        [rr, lr, rl, 1, 1],
        [lr, ll, rr, -1, 1],
        [rl, ll, rr, 1, -1],
      ]
      for (const [value, one, two, rowSide, colSide] of quadrants) {
        if (!(value > STANDOUT)) continue
        const strength = value - Math.max(orZero(one), orZero(two))
        if (strength > STANDOUT) found.push({ p, q, rowSide, colSide, strength })
      }
    }
  }

  // The strongest of each neighbourhood, of each kind.
  found.sort((x, y) => y.strength - x.strength)
  const kept: typeof found = []
  for (const corner of found) {
    const near = kept.some(
      (other) =>
        other.rowSide === corner.rowSide &&
        other.colSide === corner.colSide &&
        Math.abs(other.p - corner.p) <= w &&
        Math.abs(other.q - corner.q) <= w,
    )
    if (!near) kept.push(corner)
    if (kept.length >= MOST) break
  }

  // Placed at the picture's cells: the most refused junction of the file's own
  // within a coarse cell, where there is one; else a sequence's end there; else
  // the coarse point.
  const offsets: number[] = []
  for (let a = 0; a < n; a++) if (a === 0 || sequenceOf[a] !== sequenceOf[a - 1]) offsets.push(a)
  offsets.push(n)
  const sequences: AxisStretch[] = offsets.slice(0, -1).map((from, i) => ({ from, to: offsets[i + 1] }))
  const identity = new Int32Array(n)
  for (let a = 0; a < n; a++) identity[a] = a
  const along = junctionsAlong(new EditedMap(contacts, expected, identity), sequences)
  const edges = new Set(offsets)
  const place = (edge: number): number => {
    const at = firstCell[edge]
    let best = at
    let bestScore = -0.2 * expected.unit
    for (let x = Math.max(1, at - f); x <= Math.min(n - 1, at + f); x++) {
      const score = along.score[x]
      if (score < bestScore) {
        best = x
        bestScore = score
      }
    }
    if (best !== at) return best
    for (let x = Math.max(0, at - f); x <= Math.min(n, at + f); x++) if (edges.has(x)) return x
    return at
  }
  return kept.map((corner) => {
    const row = place(corner.p)
    const col = place(corner.q)
    return row <= col
      ? { row, col, rowSide: corner.rowSide, colSide: corner.colSide, strength: corner.strength }
      : { row: col, col: row, rowSide: corner.colSide, colSide: corner.rowSide, strength: corner.strength }
  })
}
