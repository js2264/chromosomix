/**
 * A suggestion's points placed finer than the picture's cell (SPECS §27.5).
 * The method searches the whole assembly at the picture's resolution; each
 * point a suggestion puts inside a sequence — where it splits, the two ends of
 * a stretch it turns or moves, and where a move puts it — is then placed again
 * at the finer rungs the map is deep enough for, by one bounded read around it
 * at each.
 *
 * At a rung, the point is the cut within a cell and a half of where the rung
 * above put it that the map least supports: across it, the contacts of a
 * window's width either side, over what the contact law would put there. Where
 * the junction is wrong the two sides lie apart in the genome and share what
 * strangers share; a bin to either side, the window takes in cells of one side
 * and its support climbs. The law is the square's own, taken from the cells no
 * cut it weighs crosses, so neither the balancing nor the rung's scale matter.
 *
 * A point the rung does not refuse — nothing under half an adjacency's support
 * within reach, or too little of its window read — stays where the rung above
 * put it, and no finer rung is read for it. Pure but for the read it is given:
 * tested with a square built by hand and with a scramble of the demo through
 * the lens.
 */

import type { EditStep, EditedAssembly } from '../genome/edit'
import type { LensGrid } from './grid'
import type { SequenceEvidence } from './sequenceEvidence'
import type { Suggestion } from './suggest'
import { stepText } from './words'

/** Bins either side of a cut that its support is counted over: the method's own window. */
export const REFINE_WINDOW = 16

/** How far from where the rung above put it a point is looked for, in that rung's cells. */
export const REFINE_REACH = 1.5

/** The most one read steps finer than the rung above, so its reach is at most 24 bins. */
export const REFINE_STEP = 16

/** A junction supported by less than this share of what the law puts across it is refused. */
export const REFINE_REFUSED = 0.5

/** The least share of a cut's window that must hold a value for its support to count. */
const REFINE_SEEN = 0.25

/** The fewest cells of one distance the square's own law is taken from. */
const LAW_LEAST = 4

/** A point of an edited sequence where a suggestion takes a junction away or makes one. */
export interface RefinePoint {
  sequence: string
  bp: number
}

/** Where a finer rung placed a point, the rung's bin, and the support the map gave the junction there. */
export interface RefinedPoint {
  bp: number
  binsize: number
  support: number
}

/**
 * A square of one rung around a point, through the edit: `n` bins a side,
 * row-major, `NaN` where the map holds nothing it trusts.
 */
export interface RefineSquare {
  n: number
  values: ArrayLike<number>
}

/** Reads bins `[lo, hi)` of an edited sequence at `size` a bin, both ways: `null` where it cannot. */
export type ReadSquare = (sequence: string, lo: number, hi: number, size: number) => Promise<RefineSquare | null>

/**
 * The rungs a point is placed at, coarse to fine: from the picture's cell,
 * each time the finest rung at least twice as fine as the last and no more
 * than {@link REFINE_STEP} times — else the coarsest finer one — and never
 * finer than `least`, what the map is deep enough to show.
 */
export function refineChain(rungs: readonly number[], cell: number, least: number): number[] {
  const sizes = [...new Set(rungs)].filter((size) => size > 0 && size >= least).sort((a, b) => a - b)
  const chain: number[] = []
  let last = cell
  for (;;) {
    const finer = sizes.filter((size) => size * 2 <= last)
    if (finer.length === 0) break
    const next = finer.find((size) => last / size <= REFINE_STEP) ?? finer[finer.length - 1]
    chain.push(next)
    last = next
  }
  return chain
}

/** A distance's expected contacts in the square: the median of its cells, or their mean where most hold none. */
function lawOf(values: number[]): number {
  if (values.length < LAW_LEAST) return Number.NaN
  values.sort((a, b) => a - b)
  const middle = values.length >> 1
  const median = values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2
  if (median > 0) return median
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  return mean > 0 ? mean : Number.NaN
}

/**
 * The cut among the square's bin edges `from … to` the map least supports:
 * across it, the contacts of `window` bins either side over the square's own
 * law — each distance's median over the cells no cut in range crosses, both
 * ends before the first or both at or after the last, so that the junction
 * being placed does not lower the law it is measured against. `null` where no
 * cut's window holds enough to say.
 */
export function leastSupported(square: RefineSquare, from: number, to: number, window = REFINE_WINDOW): { cut: number; support: number } | null {
  const n = square.n
  const values = square.values
  const far = 2 * window - 1
  const law = new Float64Array(far + 1).fill(Number.NaN)
  for (let d = 1; d <= far; d++) {
    const held: number[] = []
    for (let i = 0; i + d < n; i++) {
      const j = i + d
      if (!(j < from || i >= to)) continue
      const v = values[i * n + j]
      if (!Number.isNaN(v)) held.push(v)
    }
    law[d] = lawOf(held)
  }
  const middle = (from + to) / 2
  let best: { cut: number; support: number } | null = null
  for (let c = Math.max(1, from); c <= Math.min(n - 1, to); c++) {
    let observed = 0
    let expected = 0
    let seen = 0
    for (let i = Math.max(0, c - window); i < c; i++) {
      for (let j = c; j < Math.min(n, c + window); j++) {
        const e = law[j - i]
        const v = values[i * n + j]
        if (Number.isNaN(v) || !(e > 0)) continue
        observed += v
        expected += e
        seen++
      }
    }
    if (seen < REFINE_SEEN * window * window || !(expected > 0)) continue
    const support = observed / expected
    // Of two cuts as poorly supported, the one nearer where the rung above put it.
    const better = best === null || support < best.support - 1e-9 || (support <= best.support + 1e-9 && Math.abs(c - middle) < Math.abs(best.cut - middle))
    if (better) best = { cut: c, support }
  }
  return best
}

/**
 * A point placed at each rung of `chain` in turn, from the picture's `cell`:
 * the base pair it ends at, the finest rung that placed it and the support
 * there, or `null` where the first rung already could not.
 */
export async function refinePoint(point: RefinePoint, length: number, cell: number, chain: readonly number[], read: ReadSquare): Promise<RefinedPoint | null> {
  let bp = point.bp
  let last = cell
  let placed: RefinedPoint | null = null
  const w = REFINE_WINDOW
  for (const size of chain) {
    const bins = Math.ceil(length / size)
    const centre = Math.round(bp / size)
    const reach = Math.ceil((REFINE_REACH * last) / size)
    const from = Math.max(1, centre - reach)
    const to = Math.min(bins - 1, centre + reach)
    if (to < from) break
    // Room either side for the window and, past it, the law.
    const lo = Math.max(0, from - 3 * w)
    const hi = Math.min(bins, to + 3 * w)
    const square = await read(point.sequence, lo, hi, size)
    if (square === null || square.n !== hi - lo) break
    const found = leastSupported(square, from - lo, to - lo)
    if (found === null || !(found.support < REFINE_REFUSED)) break
    const at = (lo + found.cut) * size
    if (!(at > 0 && at < length)) break
    bp = at
    last = size
    placed = { bp: at, binsize: size, support: found.support }
  }
  return placed
}

/** Where a move puts its stretch, on its sequence as it stands: `at` is measured with the stretch taken out. */
function placeOf(step: Extract<EditStep, { op: 'move' }>): number {
  return step.into !== step.sequence || step.at < step.from ? step.at : step.at + (step.to - step.from)
}

/** A point of a step, as the step names it. */
function stepPoints(step: EditStep): RefinePoint[] {
  switch (step.op) {
    case 'split':
      return [{ sequence: step.sequence, bp: step.at }]
    case 'invert':
      return [
        { sequence: step.sequence, bp: step.from },
        { sequence: step.sequence, bp: step.to },
      ]
    case 'move':
      return [
        { sequence: step.sequence, bp: step.from },
        { sequence: step.sequence, bp: step.to },
        { sequence: step.into, bp: placeOf(step) },
      ]
    default:
      return []
  }
}

/**
 * The points of a suggestion the finer rungs may place: each inside its
 * sequence, not at a junction the edit already makes — exact — and not within
 * a cell of a gap of `N`, which places it to the base already.
 */
export function pointsOf(suggestion: Suggestion, assembly: EditedAssembly, cell: number, evidence?: SequenceEvidence | null): RefinePoint[] {
  const points = stepPoints(suggestion.step)
  if (points.length === 0) return []
  const junctions = new Set(assembly.junctions().map((junction) => `${junction.sequence}:${junction.at}`))
  return points.filter((point) => {
    const length = assembly.lengthOf(point.sequence)
    if (length === null || !(point.bp > 0 && point.bp < length)) return false
    if (junctions.has(`${point.sequence}:${point.bp}`)) return false
    const original = assembly.toOriginal(point.sequence, point.bp)
    if (original === null) return false
    const gaps = evidence?.facts.get(original.sequence)?.gaps ?? []
    return !gaps.some(([lo, hi]) => hi + cell >= original.bp && lo - cell <= original.bp)
  })
}

/** A point's key, for the placements a stage keeps. */
export function pointKey(point: RefinePoint): string {
  return `${point.sequence}:${point.bp}`
}

/** A rung's bin in words: `1 kb`, `2.5 kb`, `500 bp`. */
export function binWords(bp: number): string {
  if (bp >= 1_000_000) return `${Number((bp / 1_000_000).toPrecision(3))} Mb`
  if (bp >= 1000) return `${Number((bp / 1000).toPrecision(3))} kb`
  return `${bp} bp`
}

/**
 * A suggestion with its points where the finer rungs placed them: the step,
 * its words and its marks follow, the confidence stays — the method weighed it
 * at the picture's cells — and what it rests on says to what bin. The
 * suggestion as it was where no point moved, or where the points as placed
 * would name no step: a stretch of nothing, a place inside the stretch it moves.
 * A point a finer rung put where the picture did is placed as much as one it
 * moved, and says so.
 */
export function refinedSuggestion(
  grid: LensGrid,
  suggestion: Suggestion,
  placedAt: (point: RefinePoint) => RefinedPoint | null | undefined,
): Suggestion {
  const step = suggestion.step
  const sizes: number[] = []
  const shifts = new Map<number, number>()
  const place = (sequence: string, bp: number): number => {
    const placed = placedAt({ sequence, bp })
    if (placed === null || placed === undefined) return bp
    // A finer rung that put it where the picture did placed it too.
    sizes.push(placed.binsize)
    if (placed.bp === bp) return bp
    // Its mark follows it, to the picture's nearest edge.
    const before = grid.unitOf(sequence, bp)
    const after = grid.unitOf(sequence, placed.bp)
    if (before !== null && after !== null) shifts.set(Math.round(before), Math.round(after))
    return placed.bp
  }
  let next: EditStep
  if (step.op === 'split') {
    next = { ...step, at: place(step.sequence, step.at) }
  } else if (step.op === 'invert') {
    const from = place(step.sequence, step.from)
    const to = place(step.sequence, step.to)
    if (!(from < to)) return suggestion
    next = { ...step, from, to }
  } else if (step.op === 'move') {
    const from = place(step.sequence, step.from)
    const to = place(step.sequence, step.to)
    const where = place(step.into, placeOf(step))
    if (!(from < to)) return suggestion
    let at = where
    if (step.into === step.sequence) {
      if (where > from && where < to) return suggestion
      at = where <= from ? where : where - (to - from)
    }
    next = { ...step, from, to, at }
  } else {
    return suggestion
  }
  if (sizes.length === 0) return suggestion
  const shift = (unit: number): number => shifts.get(unit) ?? unit
  const stretch = suggestion.stretch === null ? null : ([shift(suggestion.stretch[0]), shift(suggestion.stretch[1])] as [number, number])
  // A stretch the picture can no longer draw keeps the marks the method drew.
  const drawn = stretch === null || stretch[0] < stretch[1]
  return {
    ...suggestion,
    step: next,
    words: stepText(next),
    ...(drawn
      ? {
          breaks: suggestion.breaks.map(shift),
          extent: [shift(suggestion.extent[0]), shift(suggestion.extent[1])].sort((a, b) => a - b) as [number, number],
          stretch,
          target: suggestion.target === null ? null : shift(suggestion.target),
          corners: suggestion.corners.map((corner) => {
            const row = shift(corner.row)
            const col = shift(corner.col)
            return row <= col
              ? { ...corner, row, col }
              : { ...corner, row: col, col: row, rowSide: corner.colSide, colSide: corner.rowSide }
          }),
        }
      : {}),
    evidence: [...suggestion.evidence.filter((chip) => !chip.startsWith('refined at ')), `refined at ${binWords(Math.max(...sizes))}`],
  }
}
