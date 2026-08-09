/**
 * Aggregate peak analysis: many small squares of the matrix, averaged.
 *
 * The kernel. What makes it worth its own module is not the averaging — that is
 * a running sum — but the three decisions around it, each of which changes what
 * the picture means.
 *
 * **Reads are per window, at the file's own resolution, never a bounding box.**
 * This is a deliberate reversal of the obvious optimisation and the reason is
 * resolution: a whole-genome or bounding-box read is pooled at `RASTER_MAX_DIM`
 * (§7.2), so a pileup taken from one silently inherits a coarser bin than the
 * reader asked for, on any genome large enough for it to matter — and nothing in
 * the picture would say so. `k` windows inherit nothing. Where windows happen to
 * sit near each other they are read together (see `analysis/run/apa.ts`), which
 * is an optimisation of the *reads* and not of the resolution.
 *
 * **The control is distance-matched by default, not observed/expected.** Both
 * are offered and both are honest, but they control for different things. O/E
 * divides by the expected at each diagonal offset, which removes the distance
 * decay and nothing else. A distance-matched control is a pileup of *shifted*
 * anchor pairs at the same separations, which removes the distance decay **and**
 * whatever local coverage, mappability and compartment background the real
 * anchors sit in. On a real loop set the difference is large and in the
 * direction that matters: O/E over-reports, because loops sit in active regions
 * that are hot for reasons that have nothing to do with the loop.
 *
 * **The enrichment is a corner ratio, and it is reported.** A pileup always
 * looks like something. P2LL — the centre against the lower-left corner — is the
 * number that says whether it looks like a dot, and a pileup published without
 * one is a picture doing the work a statistic should.
 */

/** A running mean over many equally-shaped windows. */
export class PileupAccumulator {
  private readonly sum: Float64Array
  private readonly count: Float64Array
  /** Windows that contributed at least one cell. */
  private windows = 0

  constructor(
    readonly rows: number,
    readonly cols: number,
  ) {
    this.sum = new Float64Array(rows * cols)
    this.count = new Float64Array(rows * cols)
  }

  /**
   * Add one window, already extracted and in this pileup's shape.
   *
   * `NaN` cells are skipped per cell rather than per window, so a window with a
   * balancer-dropped row still contributes everything else it has. The count is
   * therefore per cell too — which is what makes the mean of a pileup over
   * ragged windows the mean of what was actually seen.
   */
  add(values: ArrayLike<number>): void {
    let any = false
    for (let i = 0; i < this.sum.length; i++) {
      const value = values[i]
      if (!Number.isFinite(value)) continue
      this.sum[i] += value
      this.count[i] += 1
      any = true
    }
    if (any) this.windows++
  }

  /** The pileup, with `NaN` where no window had a value. */
  finish(): { values: Float32Array; n: number } {
    const values = new Float32Array(this.sum.length)
    for (let i = 0; i < values.length; i++) {
      values[i] = this.count[i] > 0 ? this.sum[i] / this.count[i] : Number.NaN
    }
    return { values, n: this.windows }
  }
}

/**
 * One window of a square, resampled to a fixed shape.
 *
 * `fixed` mode is a straight copy: the window is already the right size, because
 * it was asked for that way. `scaled` mode is the one that needs arithmetic —
 * every domain is a different number of bins and they all have to land on the
 * same grid — and it is area-weighted rather than nearest-neighbour, for the
 * reason `render/tracks.ts` gives about pixels: taking whichever input cell an
 * output cell starts in makes the picture jump as the input size changes, which
 * across a set of differently sized domains is a blur that looks like biology.
 */
export function resampleWindow(
  source: ArrayLike<number>,
  sourceRows: number,
  sourceCols: number,
  outRows: number,
  outCols: number,
): Float64Array {
  const out = new Float64Array(outRows * outCols)
  if (sourceRows === outRows && sourceCols === outCols) {
    for (let i = 0; i < out.length; i++) out[i] = source[i]
    return out
  }
  const weights = new Float64Array(outRows * outCols)
  const rowScale = outRows / sourceRows
  const colScale = outCols / sourceCols

  for (let r = 0; r < sourceRows; r++) {
    const rLo = r * rowScale
    const rHi = (r + 1) * rowScale
    for (let c = 0; c < sourceCols; c++) {
      const value = source[r * sourceCols + c]
      if (!Number.isFinite(value)) continue
      const cLo = c * colScale
      const cHi = (c + 1) * colScale
      for (let orow = Math.floor(rLo); orow < Math.min(outRows, Math.ceil(rHi)); orow++) {
        const rOverlap = Math.min(rHi, orow + 1) - Math.max(rLo, orow)
        if (!(rOverlap > 0)) continue
        for (let ocol = Math.floor(cLo); ocol < Math.min(outCols, Math.ceil(cHi)); ocol++) {
          const cOverlap = Math.min(cHi, ocol + 1) - Math.max(cLo, ocol)
          if (!(cOverlap > 0)) continue
          const weight = rOverlap * cOverlap
          out[orow * outCols + ocol] += value * weight
          weights[orow * outCols + ocol] += weight
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) {
    out[i] = weights[i] > 0 ? out[i] / weights[i] : Number.NaN
  }
  return out
}

/**
 * Peak to lower-left: the centre of a pileup against its lower-left corner.
 *
 * The conventional APA statistic, and the corner is not arbitrary. On an
 * off-diagonal pileup the lower-left quadrant is the region *further* from the
 * diagonal on one anchor and *nearer* on the other — background at a comparable
 * separation, with none of the loop in it. Taking the whole border instead would
 * include the two quadrants that a stripe runs through, and a stripe would then
 * read as a dot.
 *
 * `NaN` where either part has nothing in it: a ratio against an empty corner is
 * not a large number, it is no number.
 */
export function p2ll(values: ArrayLike<number>, rows: number, cols: number): number {
  const quadrant = Math.max(1, Math.floor(Math.min(rows, cols) / 5))
  const centreR = Math.floor(rows / 2)
  const centreC = Math.floor(cols / 2)
  const half = Math.max(0, Math.floor(quadrant / 2))

  const mean = (r0: number, r1: number, c0: number, c1: number): number => {
    let total = 0
    let seen = 0
    for (let r = Math.max(0, r0); r < Math.min(rows, r1); r++) {
      for (let c = Math.max(0, c0); c < Math.min(cols, c1); c++) {
        const value = values[r * cols + c]
        if (!Number.isFinite(value)) continue
        total += value
        seen++
      }
    }
    return seen === 0 ? Number.NaN : total / seen
  }

  const peak = mean(centreR - half, centreR + half + 1, centreC - half, centreC + half + 1)
  const corner = mean(rows - quadrant, rows, 0, quadrant)
  if (!Number.isFinite(peak) || !Number.isFinite(corner) || corner === 0) return Number.NaN
  return peak / corner
}

/** Divide one pileup by another, cell by cell. */
export function ratioOf(
  numerator: ArrayLike<number>,
  denominator: ArrayLike<number>,
): Float32Array {
  const out = new Float32Array(numerator.length)
  for (let i = 0; i < out.length; i++) {
    const a = numerator[i]
    const b = denominator[i]
    // A zero denominator gives no ratio rather than an infinity: an infinity
    // cannot be drawn on a diverging scale, cannot be written to a bigWig, and
    // would take the colour range of the whole picture with it (§18.7).
    out[i] = Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : Number.NaN
  }
  return out
}

/** One pair of anchors, in absolute bins. */
export interface AnchorPair {
  row: number
  col: number
  /** Bins between them; `col - row` for an ordered pair. */
  separation: number
}

/**
 * Controls at the same separations, drawn by shifting both anchors together.
 *
 * The shift preserves the separation exactly, which is the whole point: a
 * control at a different distance would be controlling for the wrong thing, and
 * the distance decay would come back as signal. The offset is drawn from a
 * seeded generator (§18.4) and is bounded so a control stays on the same
 * sequence as the pair it came from — a "control" that lands in trans is
 * measuring a different quantity entirely.
 *
 * Controls that cannot be placed are dropped rather than clamped: clamping would
 * pile several controls onto the same cells and give the denominator a spurious
 * structure of its own.
 */
export function shiftedControls(
  pair: AnchorPair,
  bounds: { from: number; to: number },
  options: { perPair: number; minShift: number; maxShift: number; rng(): number },
): AnchorPair[] {
  const out: AnchorPair[] = []
  for (let i = 0; i < options.perPair; i++) {
    const magnitude =
      options.minShift + Math.floor(options.rng() * (options.maxShift - options.minShift + 1))
    const sign = options.rng() < 0.5 ? -1 : 1
    const row = pair.row + sign * magnitude
    const col = pair.col + sign * magnitude
    if (row < bounds.from || col >= bounds.to) continue
    out.push({ row, col, separation: pair.separation })
  }
  return out
}
