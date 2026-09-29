/**
 * Suggestions (SPECS §27.5, §27.6): the edits the map favours over the
 * reference as the reader has made it, each a trade of junctions, ranked by the
 * chance a curator would accept it.
 *
 * **Candidates** are points of the edited axis worth weighing: every sequence's
 * two ends, every junction an edit made, every breakpoint the map refuses, and
 * both points of every corner the detector found (`corners.ts`), carried from
 * the file's order to wherever the edit put them. Each point has an end either
 * side of it, and a walk from an end stops at the next point — past it, after
 * the edit being weighed, the sequence may be somewhere else.
 *
 * **Every edit trades junctions** (§27.5): it takes some away and makes
 * others, and its gain is the scores of what it makes less the scores of what
 * it takes. A split takes one; a turn of `[x, y)` takes two and makes the two a
 * bow-tie's arms are; a move takes three and makes three; a join makes one. A
 * suggestion is the best trade its points admit, the best first, no point in
 * two of them.
 *
 * **The confidence** is a logistic model over a few features of it, the map's
 * gain first, with the initial weights below and the reason for each; review
 * mode moves the weights with every answer ({@link learn}).
 */

import type { EditStep } from '../genome/edit'
import type { PictureContacts } from '../metacooler/picture'
import type { FileCorner } from './corners'
import { JOIN_GAP } from './gestures'
import type { GridSequence, LensGrid } from './grid'
import { EditedMap, breakpointsOf, junctionScore, junctionsAlong, type Apart, type End, type Expected, type Junction } from './method'
import { stepText } from './words'

export type SuggestionKind = 'split' | 'turn' | 'move' | 'join'

/** Two ends a suggestion would bring together, as the stage draws them: a corner, in units of the edited axis. */
export interface SuggestedCorner {
  row: number
  col: number
  /** Which side of each point its end lies: `-1` before it, `1` after it. */
  rowSide: 1 | -1
  colSide: 1 | -1
  /** The junction score the two would make, in units. */
  score: number
}

export interface Suggestion {
  /**
   * Stable across edits: its kind and the ends it moves, by the picture's own
   * cells and the way each reads there — so a suggestion turned down stays
   * turned down after another edit, which moves where it is drawn.
   */
  key: string
  kind: SuggestionKind
  /** The step accepting it makes. */
  step: EditStep
  /** It, in words: what the history will say. */
  words: string
  /** What it makes less what it takes, in units of one clean junction (§27.5). */
  gain: number
  /** The chance a curator would accept it. */
  confidence: number
  /** What the confidence was computed from: the gain, the size, how much of its windows held anything, and how much brighter than an adjacency its corners are. */
  features: number[]
  /** The points whose junctions it takes away: edges of the edited axis. */
  breaks: number[]
  /** The ends it brings together. */
  corners: SuggestedCorner[]
  /** The stretch of the axis it concerns, lowest first, for the rail. */
  extent: [number, number]
  /** The stretch it turns or moves, in units; `null` for a split or a join. */
  stretch: [number, number] | null
  /** Where a move puts it, in units. */
  target: number | null
  /** What it rests on, as chips. */
  evidence: string[]
}

/** The confidence model: an intercept, then one weight per feature. */
export type Weights = readonly number[]

/**
 * The initial weights (§27.5), each with its reason:
 *
 * - **−1.5**, the intercept: a suggestion with nothing behind it is not one a
 *   curator would take — about one in five.
 * - **2** on `log₂(1 + gain)`: the map's evidence, counted in adjacencies (one
 *   made is one; a turned stretch put back about four), on a log so the first
 *   adjacency's worth counts more than the fifth.
 * - **1.5** on `log₁₀(cells / 4)` below four cells: a stretch of a cell or two
 *   can be a corner one noisy cell made.
 * - **2** on the share of its windows that held anything, less one: a window the
 *   balancer emptied is weaker evidence either way.
 * - **2.5** on how far past two and a half times the contact law the corner of
 *   a junction it makes stands, in doublings: contacts brighter than two truly
 *   adjacent stretches share are more often a repeat the reads could not place —
 *   the elements every telomere carries — than an adjacency, and a corner ten
 *   times the law is offered below even odds whatever it would gain.
 */
export const INITIAL_WEIGHTS: Weights = [-1.5, 2, 1.5, 2, 2.5]

/** Doublings of the contact law a junction's corner may stand at before it counts against it. */
const EXCESS_FREE = Math.log2(2.5)

/** The least gain a suggestion is offered at, in units: below it, a change is noise. */
const LEAST_GAIN = 0.1

/**
 * Assemblies of more sequences than this are joined only where a corner says
 * two of their ends meet: every pair of free ends of thousands of contigs is
 * millions of windows.
 */
const JOIN_ALL_BELOW = 64

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z))
}

/** The confidence of a suggestion with these features, under these weights. */
export function confidenceOf(features: readonly number[], weights: Weights = INITIAL_WEIGHTS): number {
  let z = weights[0] ?? 0
  for (let k = 0; k < features.length; k++) z += (weights[k + 1] ?? 0) * features[k]
  return sigmoid(z)
}

/**
 * One answer, learned (§27.6): a step of logistic regression towards it —
 * accepted is `1`, rejected `0` — pulled back towards the initial weights by a
 * prior strong enough that three answers cannot overturn the map and weak
 * enough that thirty can teach it what this file's evidence means.
 */
export function learn(weights: Weights, features: readonly number[], accepted: boolean): number[] {
  const rate = 0.1
  const prior = 0.15
  const predicted = confidenceOf(features, weights)
  const error = (accepted ? 1 : 0) - predicted
  const x = [1, ...features]
  return weights.map((w, k) => w + rate * (error * (x[k] ?? 0) - prior * (w - (INITIAL_WEIGHTS[k] ?? 0))))
}

/** What the method needs, and the edit it reads the map through. */
export interface SuggestInput {
  contacts: PictureContacts
  expected: Expected
  /** The corners of the file, in its own order (`corners.ts`). */
  corners: readonly FileCorner[]
  grid: LensGrid
  weights?: Weights
}

/** The suggestions, best first, and what they were found from. */
export interface Suggested {
  list: Suggestion[]
  /** The junction score at every edge of the edited axis (`NaN` where there is none). */
  along: Float64Array
  /** The edges the map refuses. */
  breakpoints: number[]
  /** The unit the gains are counted in. */
  unit: number
}

/** A point of one edited sequence worth weighing. */
interface Point {
  sequence: number
  x: number
  /** Inside its sequence, where the reference makes a junction; not one of its two ends. */
  inside: boolean
  /** The map refuses the junction the reference makes here. */
  refused: boolean
  /**
   * Open to a trade: refused, or a junction an edit made that the map cannot
   * measure. A junction of the file's own with no evidence either way — a
   * masked centromere, an rDNA array — is the file's, and is trusted; one the
   * reader made there has nothing behind it but the hand.
   */
  open: boolean
  /** Named by a corner the detector found. */
  cornered: boolean
}

/** A trade under consideration. */
interface Trade {
  kind: SuggestionKind
  gain: number
  /** Its points: the ones whose junctions it takes away, then, for a move, where it puts the stretch. */
  points: Point[]
  /** The junctions it makes. */
  made: Array<[End, End]>
  /** The junctions it takes away, as they are scored. */
  taken: Array<[End, End]>
  step: EditStep
  stretch: [number, number] | null
  target: number | null
  cells: number
  seen: number
  /** How far past the contact law the brightest corner it makes stands, in doublings. */
  excess: number
}

/** The suggestions for the reference as it now stands, best first. */
export function suggest(input: SuggestInput): Suggested {
  const { grid, expected } = input
  const map = new EditedMap(input.contacts, expected, grid.cellMap)
  const unit = map.unit
  const sequences = grid.sequences
  const stretches = sequences.map((sequence) => ({ from: sequence.from, to: sequence.to }))
  const along = junctionsAlong(map, stretches)
  const breakpoints = breakpointsOf(along.score, stretches, unit, map.window)

  // Which way each cell of the axis reads the file, and where each cell of the
  // file is on the axis: the corners are in the file's order.
  const n = grid.n
  const strand = new Int8Array(n)
  for (const part of grid.parts) {
    if (part.piece !== null) strand.fill(part.piece.strand, part.from, part.to)
  }
  const pictureCells = input.contacts.n
  const landingStart = new Int32Array(pictureCells + 1)
  for (let e = 0; e < n; e++) {
    const a = grid.cellMap[e]
    if (a >= 0) landingStart[a + 1]++
  }
  for (let a = 0; a < pictureCells; a++) landingStart[a + 1] += landingStart[a]
  const landings = new Int32Array(landingStart[pictureCells])
  const fill = landingStart.slice(0, pictureCells)
  for (let e = 0; e < n; e++) {
    const a = grid.cellMap[e]
    if (a >= 0) landings[fill[a]++] = e
  }
  const sequenceAt = (cell: number): number => {
    let lo = 0
    let hi = sequences.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (cell < sequences[mid].from) hi = mid - 1
      else if (cell >= sequences[mid].to) lo = mid + 1
      else return mid
    }
    return -1
  }

  // The points: every sequence's two ends, every junction an edit made, every
  // breakpoint, and both ends of every corner, wherever the edit put them — each
  // one place, so a point within a quarter of a window of one already chosen is
  // that one: an edit's junction is exact, and the breakpoint the map finds a
  // cell from it is the same break, as is a corner's end placed beside it.
  const merge = Math.max(2, Math.round(map.window / 4))
  const chosen: Array<Set<number>> = sequences.map((sequence) => new Set([sequence.from, sequence.to]))
  const cornered: Array<Set<number>> = sequences.map(() => new Set<number>())
  /** The point `x` is, in sequence `s`: one already chosen within reach, else `x` itself, added. */
  const choose = (s: number, x: number): number => {
    let best = -1
    let distance = merge + 1
    for (const held of chosen[s]) {
      const d = Math.abs(held - x)
      if (d < distance) {
        best = held
        distance = d
      }
    }
    if (best >= 0) return best
    chosen[s].add(x)
    return x
  }
  for (const x of [...grid.junctions(), ...breakpoints]) {
    const s = sequenceAt(x)
    if (s >= 0 && x > sequences[s].from) choose(s, x)
  }
  /** A corner's end, at every point the edit put the cell it is anchored at: their keys. */
  const endPoint = (anchor: number, side: 1 | -1): string[] => {
    if (anchor < 0 || anchor >= pictureCells) return []
    const keys: string[] = []
    for (let k = landingStart[anchor]; k < landingStart[anchor + 1]; k++) {
      const e = landings[k]
      const dir = side * strand[e]
      const s = sequenceAt(e)
      if (s < 0) continue
      const x = choose(s, dir < 0 ? e + 1 : e)
      cornered[s].add(x)
      keys.push(`${s}:${x}`)
    }
    return keys
  }
  // The two ends of each corner are partners: where a whole sequence may go
  // in, and which free ends an assembly of many sequences may join.
  const partners = new Map<string, Set<string>>()
  const link = (a: string, b: string): void => {
    let held = partners.get(a)
    if (held === undefined) {
      held = new Set()
      partners.set(a, held)
    }
    held.add(b)
  }
  for (const corner of input.corners) {
    const rows = endPoint(corner.rowSide < 0 ? corner.row - 1 : corner.row, corner.rowSide)
    const cols = endPoint(corner.colSide < 0 ? corner.col - 1 : corner.col, corner.colSide)
    for (const a of rows) {
      for (const b of cols) {
        link(a, b)
        link(b, a)
      }
    }
  }
  const partnered = (a: Point, b: Point): boolean => partners.get(`${a.sequence}:${a.x}`)?.has(`${b.sequence}:${b.x}`) === true
  const made = new Set(grid.junctions())
  const points: Point[][] = sequences.map((sequence, s) =>
    [...chosen[s]]
      .filter((x) => x >= sequence.from && x <= sequence.to)
      .sort((a, b) => a - b)
      .map((x) => {
        const inside = x > sequence.from && x < sequence.to
        const refused = inside && along.score[x] < 0
        const open = refused || (inside && made.has(x) && !(along.score[x] >= 0))
        return { sequence: s, x, inside, refused, open, cornered: cornered[s].has(x) }
      }),
  )

  // An end of a point, walking away from it until the trade's next point or
  // the sequence's end — past either, after the trade, the sequence may be
  // somewhere else.
  const endOf = (point: Point, side: 1 | -1, walls: readonly Point[]): End | null => {
    const sequence = sequences[point.sequence]
    if (side < 0 ? point.x <= sequence.from : point.x >= sequence.to) return null
    let lo = sequence.from
    let hi = sequence.to
    for (const wall of walls) {
      if (wall.sequence !== point.sequence) continue
      if (wall.x < point.x && wall.x > lo) lo = wall.x
      if (wall.x > point.x && wall.x < hi) hi = wall.x
    }
    return side < 0 ? { cell: point.x - 1, dir: -1, lo, hi: point.x } : { cell: point.x, dir: 1, lo: point.x, hi }
  }

  // Junction scores, each computed once.
  const memo = new Map<string, Junction>()
  const keyOf = (e: End): string => `${e.cell}:${e.dir}:${e.lo}:${e.hi}`
  const junction = (e: End, f: End, apart: Apart): Junction => {
    const a = keyOf(e)
    const b = keyOf(f)
    const key = a < b ? `${a}|${b}|${apart}` : `${b}|${a}|${apart}`
    let held = memo.get(key)
    if (held === undefined) {
      held = junctionScore(map, e, f, apart)
      memo.set(key, held)
    }
    return held
  }
  /**
   * A junction's score against its window's own level, in units: what a trade
   * makes and what it takes away are weighed alike, so a trade is two
   * configurations compared. Only the question *is this junction refused at
   * all* is asked against the trans level ({@link junctionsAlong}).
   */
  const meets = (e: End | null, f: End | null): number => (e === null || f === null ? 0 : junction(e, f, 'local').score / unit)
  const holds = meets
  /** How far past the contact law the corner of a junction stands, in doublings. */
  const excessOf = (e: End, f: End): number => {
    let most = 0
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const r = e.cell + e.dir * i
        const c = f.cell + f.dir * j
        if (r < e.lo || r >= e.hi || c < f.lo || c >= f.hi) continue
        const v = map.value(r, c)
        if (v > 0) most = Math.max(most, v / map.expectedAt(i + j + 1))
      }
    }
    return most > 0 ? Math.log2(most) : 0
  }

  const trades: Trade[] = []
  const place = (sequence: GridSequence, x: number): number => edgeBp(grid, sequence, x)
  const push = (trade: Omit<Trade, 'seen' | 'excess'>): void => {
    if (!(trade.gain > LEAST_GAIN)) return
    let seen = 0
    let reached = 0
    for (const [e, f] of trade.made) {
      const j = junction(e, f, 'local')
      seen += j.seen
      reached += j.reached
    }
    for (const [e, f] of trade.taken) {
      const j = junction(e, f, 'local')
      seen += j.seen
      reached += j.reached
    }
    const excess = trade.made.reduce((most, [e, f]) => Math.max(most, excessOf(e, f)), 0)
    trades.push({ ...trade, seen: reached === 0 ? 0 : seen / reached, excess })
  }
  /** The junction a point makes, with a trade's walls, where it makes one. */
  const takenAt = (point: Point, walls: readonly Point[]): [End, End] | null => {
    if (!point.inside) return null
    const left = endOf(point, -1, walls)
    const right = endOf(point, 1, walls)
    return left === null || right === null ? null : [left, right]
  }

  // Splits: a junction the map refuses, taken away.
  for (const list of points) {
    for (const point of list) {
      if (!point.refused) continue
      const sequence = sequences[point.sequence]
      const taken = takenAt(point, [])
      if (taken === null) continue
      push({
        kind: 'split',
        gain: -holds(...taken),
        points: [point],
        made: [],
        taken: [taken],
        step: { op: 'split', sequence: sequence.name, at: place(sequence, point.x) },
        stretch: null,
        target: null,
        cells: Number.POSITIVE_INFINITY,
      })
    }
  }

  const everywhere = points.flat()
  const fewSequences = sequences.length <= JOIN_ALL_BELOW
  for (const list of points) {
    if (list.length === 0) continue
    const sequence = sequences[list[0].sequence]
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i]
        const q = list[j]
        const cells = q.x - p.x
        const whole = !p.inside && !q.inside
        const walls = [p, q]
        const takenP = takenAt(p, walls)
        const takenQ = takenAt(q, walls)
        const taken = [takenP, takenQ].filter((pair): pair is [End, End] => pair !== null)
        const cost = taken.reduce((sum, [e, f]) => sum + holds(e, f), 0)

        // A turn of a stretch one of whose junctions the map refuses — or
        // between two points corners name, which is how a stretch shorter than
        // a window is found: across its ends the walk reaches its far end,
        // which truly belongs there, and neither junction is refused. The left
        // flank meets the stretch's far end, the stretch's near end the right
        // flank: a bow-tie's two arms.
        if (!whole && (p.open || q.open || (p.cornered && q.cornered))) {
          const made: Array<[End, End]> = []
          const pl = endOf(p, -1, walls)
          const ql = endOf(q, -1, walls)
          const pr = endOf(p, 1, walls)
          const qr = endOf(q, 1, walls)
          if (pl !== null && ql !== null) made.push([pl, ql])
          if (pr !== null && qr !== null) made.push([pr, qr])
          push({
            kind: 'turn',
            gain: made.reduce((sum, [e, f]) => sum + meets(e, f), 0) - cost,
            points: [p, q],
            made,
            taken,
            step: { op: 'invert', sequence: sequence.name, from: place(sequence, p.x), to: place(sequence, q.x) },
            stretch: [p.x, q.x],
            target: null,
            cells,
          })
        }

        // A move: of a stretch between two refused junctions (or a refused one
        // and the sequence's end), or of a whole sequence a corner names, to
        // any point, either way round — the flanks closing up behind it.
        const movable = ((p.open || q.open) && (p.open || !p.inside) && (q.open || !q.inside)) || (whole && (p.cornered || q.cornered))
        if (!movable) continue
        let best: { gain: number; z: Point; strand: 1 | -1; made: Array<[End, End]>; taken: Array<[End, End]> } | null = null
        for (const z of everywhere) {
          if (z.sequence === p.sequence && z.x >= p.x && z.x <= q.x) continue
          // A whole sequence goes into another's interior — end to end is a
          // join — and only where a corner says one of its ends meets it.
          if (whole && (!z.inside || !(partnered(p, z) || partnered(q, z)))) continue
          const zWalls = z.sequence === p.sequence ? [p, q, z] : [z]
          const moveWalls = z.sequence === p.sequence ? [p, q, z] : walls
          const pl = endOf(p, -1, moveWalls)
          const qr = endOf(q, 1, moveWalls)
          const pr = endOf(p, 1, moveWalls)
          const ql = endOf(q, -1, moveWalls)
          const zl = endOf(z, -1, zWalls)
          const zr = endOf(z, 1, zWalls)
          const takenZ = takenAt(z, zWalls)
          const opened = takenZ === null ? 0 : holds(...takenZ)
          const flanks: Array<[End, End]> = pl !== null && qr !== null && p.inside && q.inside ? [[pl, qr]] : []
          const closing = flanks.reduce((sum, [e, f]) => sum + meets(e, f), 0)
          for (const way of [1, -1] as const) {
            const made: Array<[End, End]> = [...flanks]
            if (way === 1) {
              if (zl !== null && pr !== null) made.push([zl, pr])
              if (ql !== null && zr !== null) made.push([ql, zr])
            } else {
              if (zl !== null && ql !== null) made.push([zl, ql])
              if (pr !== null && zr !== null) made.push([pr, zr])
            }
            if (made.length === flanks.length) continue
            let gain = closing - cost - opened
            for (const [e, f] of made.slice(flanks.length)) gain += meets(e, f)
            if (best === null || gain > best.gain) {
              best = { gain, z, strand: way, made, taken: takenZ === null ? taken : [...taken, takenZ] }
            }
          }
        }
        if (best !== null) {
          const target = sequences[best.z.sequence]
          const from = place(sequence, p.x)
          const to = place(sequence, q.x)
          const at = place(target, best.z.x)
          push({
            kind: 'move',
            gain: best.gain,
            points: [p, q, best.z],
            made: best.made,
            taken: best.taken,
            step: {
              op: 'move',
              sequence: sequence.name,
              from,
              to,
              into: target.name,
              at: best.z.sequence === p.sequence && best.z.x > q.x ? at - (to - from) : at,
              strand: best.strand,
            },
            stretch: [p.x, q.x],
            target: best.z.x,
            cells,
          })
        }
      }
    }
  }

  // Joins: two sequences' free ends that meet.
  for (let a = 0; a < sequences.length; a++) {
    for (let b = a + 1; b < sequences.length; b++) {
      const A = points[a]
      const B = points[b]
      const aStart = A[0]
      const aEnd = A[A.length - 1]
      const bStart = B[0]
      const bEnd = B[B.length - 1]
      if (aStart === undefined || aEnd === undefined || bStart === undefined || bEnd === undefined) continue
      if (!fewSequences && !aStart.cornered && !aEnd.cornered) continue
      const nameA = sequences[a].name
      const nameB = sequences[b].name
      const options: Array<{ e: End | null; f: End | null; pa: Point; pb: Point; step: EditStep }> = [
        { e: endOf(aEnd, -1, []), f: endOf(bStart, 1, []), pa: aEnd, pb: bStart, step: { op: 'join', a: nameA, aEnd: 'end', b: nameB, bEnd: 'start', gap: JOIN_GAP } },
        { e: endOf(aEnd, -1, []), f: endOf(bEnd, -1, []), pa: aEnd, pb: bEnd, step: { op: 'join', a: nameA, aEnd: 'end', b: nameB, bEnd: 'end', gap: JOIN_GAP } },
        { e: endOf(aStart, 1, []), f: endOf(bStart, 1, []), pa: aStart, pb: bStart, step: { op: 'join', a: nameA, aEnd: 'start', b: nameB, bEnd: 'start', gap: JOIN_GAP } },
        { e: endOf(aStart, 1, []), f: endOf(bEnd, -1, []), pa: aStart, pb: bEnd, step: { op: 'join', a: nameB, aEnd: 'end', b: nameA, bEnd: 'start', gap: JOIN_GAP } },
      ]
      for (const option of options) {
        if (option.e === null || option.f === null) continue
        // Past a few dozen sequences, only ends a corner pairs: every pair of
        // thousands of contigs is millions of windows.
        if (!fewSequences && !partnered(option.pa, option.pb)) continue
        push({
          kind: 'join',
          gain: meets(option.e, option.f),
          points: [option.pa, option.pb],
          made: [[option.e, option.f]],
          taken: [],
          step: option.step,
          stretch: null,
          target: null,
          cells: Number.POSITIVE_INFINITY,
        })
      }
    }
  }

  // Ranked, and the best of those that share no point.
  const weights = input.weights ?? INITIAL_WEIGHTS
  const ranked = trades.map((trade) => {
    const features = [
      Math.log2(1 + Math.max(0, trade.gain)),
      Number.isFinite(trade.cells) ? Math.min(0, Math.log10(trade.cells / 4)) : 0,
      trade.seen - 1,
      -Math.max(0, trade.excess - EXCESS_FREE),
    ]
    return { trade, features, confidence: confidenceOf(features, weights) }
  })
  ranked.sort((x, y) => y.confidence - x.confidence || y.trade.gain - x.trade.gain)
  // No point in two, and none within reach of another's: two suggestions a
  // cell apart are one suggestion twice.
  const used: Point[] = []
  const taken = (point: Point): boolean => used.some((held) => held.sequence === point.sequence && Math.abs(held.x - point.x) <= merge)
  const list: Suggestion[] = []
  for (const { trade, features, confidence } of ranked) {
    if (trade.points.some(taken)) continue
    used.push(...trade.points)
    list.push(toSuggestion(trade, features, confidence, grid, unit, (e, f) => junction(e, f, 'local')))
  }
  return { list, along: along.score, breakpoints, unit }
}

/** An end's point on the axis, and the side of it the end lies. */
function pointOf(end: End): { x: number; side: 1 | -1 } {
  return end.dir < 0 ? { x: end.cell + 1, side: -1 } : { x: end.cell, side: 1 }
}

function toSuggestion(
  trade: Trade,
  features: number[],
  confidence: number,
  grid: LensGrid,
  unit: number,
  junction: (e: End, f: End) => Junction,
): Suggestion {
  const corners = trade.made.map(([e, f]): SuggestedCorner => {
    const a = pointOf(e)
    const b = pointOf(f)
    const score = junction(e, f).score / unit
    return a.x <= b.x
      ? { row: a.x, col: b.x, rowSide: a.side, colSide: b.side, score }
      : { row: b.x, col: a.x, rowSide: b.side, colSide: a.side, score }
  })
  // Where it takes a junction away — for a move, not where it puts the stretch,
  // which the map has not refused and is drawn as the place it goes.
  const cut = trade.kind === 'move' ? trade.points.slice(0, 2) : trade.points
  const breaks = cut.filter((point) => point.inside && trade.kind !== 'join').map((point) => point.x)
  const xs = [...trade.points.map((point) => point.x)]
  const extent: [number, number] = [Math.min(...xs), Math.max(...xs)]
  // The ends it moves, by the file's own cells and the way each reads there.
  const identity = trade.made
    .flat()
    .map((end) => {
      const anchor = grid.cellMap[end.cell] ?? -1
      const part = grid.partAt(end.cell)
      const reads = (part?.piece?.strand ?? 1) * end.dir
      return `${anchor}${reads < 0 ? '<' : '>'}`
    })
    .concat(trade.points.filter((point) => point.inside && trade.made.length === 0).map((point) => {
      const before = grid.cellMap[point.x - 1] ?? -1
      const after = grid.cellMap[point.x] ?? -1
      return `${before}|${after}`
    }))
    .sort()
    .join(',')
  const evidence = ['map']
  if (features[2] < -0.25) evidence.push('sparse')
  if (features[3] < 0) evidence.push('brighter than an adjacency')
  return {
    key: `${trade.kind}:${identity}`,
    kind: trade.kind,
    step: trade.step,
    words: stepText(trade.step),
    gain: trade.gain,
    confidence,
    features,
    breaks,
    corners,
    extent,
    stretch: trade.stretch,
    target: trade.target,
    evidence,
  }
}

/**
 * A point of the axis as a base pair of its edited sequence: exact at a
 * sequence's two ends and at a junction, and inside a piece the edge of the cell
 * there — placed by the map, to one cell (§27.5).
 */
export function edgeBp(grid: LensGrid, sequence: GridSequence, x: number): number {
  if (x <= sequence.from) return 0
  if (x >= sequence.to) return sequence.length
  const place = grid.place(x)
  if (place === null || place.sequence !== sequence.name) return 0
  return Math.max(0, Math.min(sequence.length, Math.round(place.bp)))
}
