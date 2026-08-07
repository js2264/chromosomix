/**
 * Values a file does not contain: coverage normalisation, iterative balancing,
 * and the distance-decay baseline every Hi-C map is read against.
 *
 * A cooler stores one number per pixel and, if somebody ran `cooler balance`,
 * one weight per bin. Everything else a reader wants — normalised counts on a
 * file nobody balanced, the ratio of a cell to what its genomic distance would
 * predict — is arithmetic over numbers that are already on screen. `ui/scores.ts`
 * offers the file's own columns because a file that went to the trouble of
 * storing an expected value had no way of saying so; this is the other half of
 * that argument, for the far more common file that stored nothing but counts.
 *
 * **Why this is honest here and would not be in HiGlass.** Every function below
 * measures a normalisation from the block it is handed. That is a genome-wide
 * statement only if the block is the genome — and spec §2 is precisely the claim
 * that it is: a MAG is 2–6 Mb, its matrix is loaded in one bounded read, and pan
 * and zoom are canvas operations over a block that never changes. A tile server
 * computing coverage from the 256×256 tile under the pointer would produce a
 * different normalisation at every zoom level and every pan; here there is one
 * block, so there is one answer. Where that stops being true — an `__unbinned__`
 * genome, a windowed region of a whole cooler chromosome — the number is a
 * statement about the window, and {@link DerivedValues.scope} is what says so
 * rather than leaving the caption to imply otherwise.
 *
 * Nothing here draws, and nothing here reads. Each function takes a dense block
 * and returns a new array of the same shape, which is what keeps the renderer,
 * the pooling layer and the reader unaware that derived values exist.
 */

/** The part of a read this module needs: shape, values, and where they sit. */
export interface BlockValues {
  nrows: number
  ncols: number
  /** Row-major, at least `nrows * ncols` long. */
  values: Float32Array
  rowExtent: readonly [number, number]
  colExtent: readonly [number, number]
}

/**
 * A stretch of one axis belonging to one sequence.
 *
 * Structurally a `worker/protocol.ts` `AxisGroup` minus everything this module
 * has no use for, and declared here rather than imported so that `render/` keeps
 * knowing nothing about the wire format — the same separation `render/heatmap.ts`
 * observes by taking a `DenseMatrix` rather than a `MatrixResult`.
 */
export interface AxisRun {
  label: string
  /** First row/column of the run within the block. */
  start: number
  /** One past the last row/column of the run within the block. */
  end: number
}

/**
 * How the cells were put on a comparable footing, before anything is read off
 * them.
 *
 * `none` is the file as written and is the default everywhere: a viewer that
 * silently normalised would be answering a question nobody asked, and the count
 * in a cell is the one number the file actually contains.
 *
 * The other three are the standard ladder, cheapest first, and they differ in
 * what they assume rather than in quality:
 *
 * - **`vc`** — vanilla coverage. Divide each cell by its two bins' coverage.
 *   One pass, no iteration, and it assumes the only bias is how often each bin
 *   was seen at all.
 * - **`vcsqrt`** — the same correction at half strength, `√` of each marginal.
 *   The convention exists because full VC over-corrects on sparse data, where a
 *   bin's marginal is as much sampling noise as it is bias.
 * - **`ice`** — the fixed point rather than the single step: rescale, remeasure,
 *   repeat until every bin contributes equally. This is what `cooler balance`
 *   writes into `/bins/weight`, so on a balanced file `ice` and `balanced`
 *   should agree to the tolerance below — and where they do not, the difference
 *   is the filtering a real balancing run does and this one deliberately does
 *   not (see {@link balanceBlock}).
 *
 * Juicer's `KR` is not a fourth entry because it is not a fourth *answer*.
 * Knight–Ruiz and iterative correction solve the same problem — the unique
 * diagonal scaling that makes a symmetric non-negative matrix doubly stochastic
 * — and converge to the same weights; KR is a Newton solver that gets there in
 * fewer passes. At §2's scale the whole matrix is at most low millions of cells
 * and the fixed point converges in milliseconds, so the faster solver would buy
 * a name in a menu and nothing a reader could see. A file balanced with `KR`
 * elsewhere and read here under `ice` shows the same picture.
 */
export type Normalisation = 'none' | 'vc' | 'vcsqrt' | 'ice'

/** Every normalisation, in the order they should be offered. */
export const NORMALISATIONS: readonly Normalisation[] = ['none', 'vc', 'vcsqrt', 'ice']

export function isNormalisation(value: string): value is Normalisation {
  return (NORMALISATIONS as readonly string[]).includes(value)
}

/**
 * Rounds of {@link balanceBlock} before it gives up and returns what it has.
 *
 * Iterative correction on a well-connected matrix converges geometrically and is
 * done in well under twenty rounds; the cap is for the matrices that do not
 * converge at all, which are the ones made almost entirely of zeros. Returning a
 * partly-converged scaling is right for those: it is still a better picture than
 * raw counts, and refusing would mean a reader with a sparse map gets an error
 * where every other normalisation gives them something.
 */
export const BALANCE_MAX_ROUNDS = 200

/**
 * Cell visits one balancing pass is allowed in total, across all its rounds.
 *
 * The round cap alone is a cap on *iterations*, and iterations are not what
 * costs: one round is one pass over the block, so 200 rounds over a 4,096²
 * whole-genome overview is 3.3 billion cell visits and a freeze measured in
 * seconds — on the main thread, at the moment a reader picks an entry from a
 * dropdown. The blocks this is really for are far smaller (§2: a MAG at 5 kb is
 * ~1,000 bins, so ~10⁶ cells, and the full 200 rounds cost less than the frame
 * they land in), and the budget is what keeps the pathological case from being
 * paid for by the ordinary one.
 *
 * Spent rather than refused, and a floor of a few rounds regardless: iterative
 * correction converges geometrically, so a dozen rounds over a large block
 * removes most of the bias the fixed point would, and stopping early is much
 * closer to right than falling back to raw counts would be. What it is not is
 * *converged*, which is why {@link balanceBlock} reports it.
 */
export const BALANCE_CELL_BUDGET = 2.5e8

/** Rounds this block can afford, between a usable floor and the cap. */
function roundsFor(cells: number): number {
  if (cells <= 0) return BALANCE_MAX_ROUNDS
  return Math.max(4, Math.min(BALANCE_MAX_ROUNDS, Math.floor(BALANCE_CELL_BUDGET / cells)))
}

/**
 * When the marginals are flat enough to stop.
 *
 * The variance of the marginals divided by their mean, which is the same
 * convergence test `cooler balance` uses. 1e-5 is far below what a 256-entry
 * colormap can show — the picture stops changing several rounds earlier — but
 * the number also has to satisfy someone comparing the result against a stored
 * weight column, and there the tolerance is the size of the disagreement.
 */
export const BALANCE_TOLERANCE = 1e-5

/**
 * What a derived array is, beside the numbers.
 *
 * The values alone cannot say what colour scale they want or what the colourbar
 * should be headed, and every caller needs both. `neutral` is the load-bearing
 * one: a ratio is not a quantity with a bright end and a dark end but one with a
 * *middle*, and a picture of one drawn on a sequential ramp anchored at zero
 * hides the only thing it is for. See {@link isDiverging}.
 */
export interface DerivedValues {
  values: Float32Array
  /**
   * The value that means "nothing to report", or `null` where the result is an
   * ordinary one-ended quantity.
   *
   * `1` for a ratio, `0` for a difference. The colour scale is made symmetric
   * about it and the default colormap becomes a diverging one; both follow from
   * this single number rather than from a flag per derivation.
   */
  neutral: number | null
  /** What the colourbar is headed and what the readout calls the number. */
  label: string
  /**
   * What the number was measured over, where that is narrower than the label
   * implies. `null` when the block is the whole of what the statement is about.
   */
  scope: string | null
}

/** Whether a derived quantity is read against a middle rather than against zero. */
export function isDiverging(derived: Pick<DerivedValues, 'neutral'>): boolean {
  return derived.neutral !== null
}

// ---------------------------------------------------------------------------
// Coverage and balancing
// ---------------------------------------------------------------------------

/**
 * The two marginals of a block, with non-finite cells contributing nothing.
 *
 * A `NaN` is a bin the balancer threw out (§6.4) and it has to be skipped rather
 * than propagated: one such bin would otherwise turn the marginal of every bin
 * it touches into `NaN`, and a single discarded row would blank the whole map.
 */
export function marginalsOf(block: BlockValues): { rows: Float64Array; cols: Float64Array } {
  const { nrows, ncols, values } = block
  const rows = new Float64Array(nrows)
  const cols = new Float64Array(ncols)
  for (let r = 0; r < nrows; r++) {
    const base = r * ncols
    let sum = 0
    for (let c = 0; c < ncols; c++) {
      const value = values[base + c]
      if (!Number.isFinite(value)) continue
      sum += value
      cols[c] += value
    }
    rows[r] = sum
  }
  return { rows, cols }
}

/**
 * Coverage normalisation: each cell divided by the coverage of its two bins.
 *
 * The marginals are put on a mean of 1 before they divide anything, which is
 * what keeps the result in the units it started in. Dividing by raw marginals
 * would leave a matrix whose values are around `1 / total`, so every colour
 * scale, every stored clip and every number in the readout would change meaning
 * with the depth of the library — and a reader flipping between `counts` and
 * `VC` would see the picture blank rather than flatten.
 *
 * `power` is `1` for VC and `0.5` for VC √; nothing else is offered, because the
 * exponent is a convention rather than a parameter and two conventions exist.
 *
 * A bin with no coverage at all gets `NaN` rather than a division by zero. That
 * is the same value a bin the balancer discarded already carries, so the raster
 * leaves both transparent and the readout says `NaN (unbalanced)` for both —
 * which is the truth in both cases: there is no normalised value for a bin
 * nothing was observed in.
 */
export function coverageNormalise(block: BlockValues, power: 0.5 | 1): Float32Array {
  const { nrows, ncols, values } = block
  const { rows, cols } = marginalsOf(block)
  const rowScale = scaleToUnitMean(rows, power)
  const colScale = scaleToUnitMean(cols, power)
  const out = new Float32Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) {
    const base = r * ncols
    const rw = rowScale[r]
    for (let c = 0; c < ncols; c++) {
      out[base + c] = rw > 0 && colScale[c] > 0 ? values[base + c] / (rw * colScale[c]) : Number.NaN
    }
  }
  return out
}

/**
 * A marginal rescaled to a mean of one over the bins that have any, raised to
 * `power`.
 *
 * The mean is taken over the *non-empty* bins only. A block half of which is a
 * contig nothing mapped to would otherwise have its mean halved by the empty
 * half, and every value in the half that does carry data would be scaled by two
 * for a reason that is a fact about the other contig.
 */
function scaleToUnitMean(marginal: Float64Array, power: 0.5 | 1): Float64Array {
  let total = 0
  let seen = 0
  for (const value of marginal) {
    if (!(value > 0)) continue
    total += value
    seen++
  }
  const out = new Float64Array(marginal.length)
  if (seen === 0) return out
  const mean = total / seen
  for (let i = 0; i < marginal.length; i++) {
    const value = marginal[i]
    out[i] = value > 0 ? (power === 1 ? value / mean : Math.sqrt(value / mean)) : 0
  }
  return out
}

/**
 * Iterative correction: the diagonal scaling under which every bin contributes
 * equally.
 *
 * The assumption is the one every balancing method makes and it is worth stating
 * because it is the reason a balanced map is read differently from a raw one:
 * *every bin should see the same total number of contacts*. Whatever it does not
 * see is bias — mappability, restriction-site density, GC, copy number — and the
 * weights are whatever makes the marginals flat. Where that assumption is wrong,
 * balancing is wrong in exactly the same way, and the classic case is real: a
 * region genuinely present at twice the copy number is corrected until it is not.
 *
 * Two updates, chosen by the block rather than offered:
 *
 * - **Symmetric**, for a block whose two axes cover the same bins. One weight
 *   vector applied to both sides, stepped by `√(target / marginal)`, so the
 *   result stays symmetric to the last bit. Alternating row and column passes
 *   over a symmetric matrix does *not* — each half-step breaks the symmetry the
 *   other restores — and a contact map that is not symmetric draws a visible
 *   seam along its own diagonal, which is the one artefact a reader is
 *   guaranteed to notice and to misread as structure.
 * - **Alternating** (Sinkhorn–Knopp), for a rectangular trans block, where there
 *   is no shared bin to give one weight to and the two axes are scaled
 *   independently.
 *
 * Rows that are entirely empty are held at zero weight throughout and emitted as
 * `NaN`; they are excluded from the target, or a matrix that is mostly empty
 * would drive the target towards zero and take every real row with it.
 *
 * `converged` is `false` where the rounds ran out — see
 * {@link BALANCE_CELL_BUDGET}. The values are still the best scaling found and
 * are still worth drawing; what a caller must not do is describe them as
 * balanced without qualification, which is what {@link DerivedValues.scope}
 * carries to the caption.
 */
export interface BalanceResult {
  values: Float32Array
  /** Whether the marginals reached {@link BALANCE_TOLERANCE} before the rounds ran out. */
  converged: boolean
}

export function balanceBlock(block: BlockValues): BalanceResult {
  const { nrows, ncols, values } = block
  const symmetric =
    nrows === ncols &&
    block.rowExtent[0] === block.colExtent[0] &&
    block.rowExtent[1] === block.colExtent[1]

  const rowWeight = new Float64Array(nrows)
  const colWeight = new Float64Array(ncols)
  const { rows: rowMass, cols: colMass } = marginalsOf(block)
  for (let r = 0; r < nrows; r++) rowWeight[r] = rowMass[r] > 0 ? 1 : 0
  for (let c = 0; c < ncols; c++) colWeight[c] = colMass[c] > 0 ? 1 : 0

  const rowSum = new Float64Array(nrows)
  const colSum = new Float64Array(ncols)
  const rounds = roundsFor(nrows * ncols)
  let converged = false
  for (let round = 0; round < rounds; round++) {
    rowSum.fill(0)
    colSum.fill(0)
    for (let r = 0; r < nrows; r++) {
      const rw = rowWeight[r]
      if (rw === 0) continue
      const base = r * ncols
      let sum = 0
      for (let c = 0; c < ncols; c++) {
        const cw = colWeight[c]
        if (cw === 0) continue
        const value = values[base + c]
        if (!Number.isFinite(value)) continue
        const scaled = rw * value * cw
        sum += scaled
        colSum[c] += scaled
      }
      rowSum[r] = sum
    }

    if (symmetric) {
      const target = meanOfActive(rowSum, rowWeight)
      // Nothing left to balance — an empty block, or one every bin of which was
      // dropped. Converged in the only sense available: another round would
      // change nothing.
      if (!(target > 0)) {
        converged = true
        break
      }
      let drift = 0
      for (let r = 0; r < nrows; r++) {
        if (rowWeight[r] === 0) continue
        const mass = rowSum[r]
        if (!(mass > 0)) {
          rowWeight[r] = 0
          colWeight[r] = 0
          continue
        }
        drift = Math.max(drift, Math.abs(mass / target - 1))
        // √ of the ratio, because the weight is applied to *both* ends of every
        // cell: a full step would overshoot by exactly the square.
        rowWeight[r] *= Math.sqrt(target / mass)
        colWeight[r] = rowWeight[r]
      }
      if (drift < BALANCE_TOLERANCE) {
        converged = true
        break
      }
      continue
    }

    const rowTarget = meanOfActive(rowSum, rowWeight)
    const colTarget = meanOfActive(colSum, colWeight)
    if (!(rowTarget > 0) || !(colTarget > 0)) {
      converged = true
      break
    }
    let drift = 0
    for (let r = 0; r < nrows; r++) {
      if (rowWeight[r] === 0) continue
      const mass = rowSum[r]
      if (!(mass > 0)) {
        rowWeight[r] = 0
        continue
      }
      drift = Math.max(drift, Math.abs(mass / rowTarget - 1))
      rowWeight[r] *= rowTarget / mass
    }
    for (let c = 0; c < ncols; c++) {
      if (colWeight[c] === 0) continue
      const mass = colSum[c]
      if (!(mass > 0)) {
        colWeight[c] = 0
        continue
      }
      drift = Math.max(drift, Math.abs(mass / colTarget - 1))
      colWeight[c] *= colTarget / mass
    }
    if (drift < BALANCE_TOLERANCE) {
      converged = true
      break
    }
  }

  const out = new Float32Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) {
    const base = r * ncols
    const rw = rowWeight[r]
    for (let c = 0; c < ncols; c++) {
      const cw = colWeight[c]
      out[base + c] = rw > 0 && cw > 0 ? rw * values[base + c] * cw : Number.NaN
    }
  }
  return { values: out, converged }
}

/** The mean of the entries whose weight is still live. */
function meanOfActive(sums: Float64Array, weights: Float64Array): number {
  let total = 0
  let seen = 0
  for (let i = 0; i < sums.length; i++) {
    if (weights[i] === 0) continue
    total += sums[i]
    seen++
  }
  return seen === 0 ? 0 : total / seen
}

// ---------------------------------------------------------------------------
// Expected, and observed over it
// ---------------------------------------------------------------------------

/**
 * The distance-decay baseline: what a cell would hold if the only thing
 * governing it were how far apart its two ends are.
 *
 * This is the single strongest signal in any Hi-C map and it is not the one
 * anybody is looking for. Contact frequency falls by two to three orders of
 * magnitude from the diagonal outwards, so a raw map is a bright diagonal
 * fading to nothing and every feature — a loop, a domain boundary, a plasmid
 * that belongs to a different genome — is a small deviation riding on it.
 * Dividing it out is what makes those deviations the picture (§7.1's colour
 * scale is doing the same job far more crudely, by clipping).
 *
 * **One curve, pooled over sequences.** Cells whose two ends are in the same
 * sequence give a mean per bin separation; cells whose ends are in different
 * sequences give a single scalar between them all. Per-sequence curves would be
 * better on an assembly whose contigs are genuinely different things, and worse
 * on the case this viewer is for: a MAG's contigs are pieces of *one* genome
 * broken by assembly rather than by biology, and a 40 kb contig on its own
 * yields eight points to fit a decay curve to. Pooling spends the whole genome's
 * cells on one curve, which is the estimate a reader of a MAG wants.
 *
 * Separation is measured in **absolute bins**, so a rectangular block covering
 * two distant windows of one contig is placed on the curve where it belongs
 * rather than at the separations its row and column indices suggest — the same
 * distinction `render/compare.ts` draws when it decides which side of the
 * diagonal a cell is on.
 */
export interface ExpectedModel {
  /** Mean value per bin separation, for cells within one sequence. */
  cis: Float64Array
  /** Mean value between any two different sequences, or `NaN` where there are none. */
  trans: number
}

export function expectedModel(
  block: BlockValues,
  runs: { rows: readonly AxisRun[]; cols: readonly AxisRun[] },
): ExpectedModel {
  const { nrows, ncols, values } = block
  const rowLabel = labelsByIndex(runs.rows, nrows)
  const colLabel = labelsByIndex(runs.cols, ncols)
  const rowStart = block.rowExtent[0]
  const colStart = block.colExtent[0]

  const span = maxSeparation(rowStart, nrows, colStart, ncols)
  const sums = new Float64Array(span + 1)
  const counts = new Float64Array(span + 1)
  let transSum = 0
  let transCount = 0

  for (let r = 0; r < nrows; r++) {
    const base = r * ncols
    const rowBin = rowStart + r
    const mine = rowLabel[r]
    for (let c = 0; c < ncols; c++) {
      const value = values[base + c]
      if (!Number.isFinite(value)) continue
      // An axis with no runs at all — a plain cooler read as one span — is one
      // sequence as far as this is concerned, which is what `null === null`
      // gives without a branch of its own.
      if (mine === colLabel[c]) {
        const d = Math.abs(rowBin - (colStart + c))
        sums[d] += value
        counts[d]++
      } else {
        transSum += value
        transCount++
      }
    }
  }

  const cis = new Float64Array(span + 1)
  for (let d = 0; d <= span; d++) cis[d] = counts[d] > 0 ? sums[d] / counts[d] : Number.NaN
  return { cis, trans: transCount > 0 ? transSum / transCount : Number.NaN }
}

/**
 * Observed over expected, cell by cell.
 *
 * The result is a **ratio**, neutral at `1`, and deliberately not a logarithm:
 * `types.ts`'s `Transform` already owns the question of what scale a picture is
 * drawn on, and `log2` is one of its answers. Returning `log2(O/E)` here would
 * put the same decision in two places and make the readout report a number no
 * reader asked for — "2.3× expected" is the sentence, and the colour scale is
 * what turns it into a position on a ramp.
 *
 * A separation nothing was observed at, and a cell whose expected value is zero,
 * both give `NaN`: there is no ratio to a baseline that does not exist, and the
 * raster already leaves `NaN` transparent.
 */
export function observedOverExpected(
  block: BlockValues,
  runs: { rows: readonly AxisRun[]; cols: readonly AxisRun[] },
  model: ExpectedModel = expectedModel(block, runs),
): Float32Array {
  const { nrows, ncols, values } = block
  const rowLabel = labelsByIndex(runs.rows, nrows)
  const colLabel = labelsByIndex(runs.cols, ncols)
  const rowStart = block.rowExtent[0]
  const colStart = block.colExtent[0]
  const out = new Float32Array(nrows * ncols)

  for (let r = 0; r < nrows; r++) {
    const base = r * ncols
    const rowBin = rowStart + r
    const mine = rowLabel[r]
    for (let c = 0; c < ncols; c++) {
      const value = values[base + c]
      if (!Number.isFinite(value)) {
        out[base + c] = Number.NaN
        continue
      }
      let expected: number
      if (mine === colLabel[c]) {
        const d = Math.abs(rowBin - (colStart + c))
        expected = d < model.cis.length ? model.cis[d] : Number.NaN
      } else {
        expected = model.trans
      }
      out[base + c] = expected > 0 ? value / expected : Number.NaN
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The two of them together
// ---------------------------------------------------------------------------

/** What a caller asks for: a normalisation, a baseline, either, or neither. */
export interface Derivation {
  normalise?: Normalisation
  /** Divide by what the genomic distance predicts. */
  expected?: boolean
}

/**
 * Apply a normalisation and then a baseline, in that order, and describe the
 * result.
 *
 * The order is not a preference. Both steps are estimates *from the block*, and
 * the distance-decay curve is an average over cells — so measuring it before the
 * coverage bias has been taken out means measuring it partly on the bias, and
 * every cell of a badly-covered bin is then compared against a baseline its own
 * under-coverage helped set. Normalise first, and the curve is a statement about
 * distance alone. It is also the order cooltools uses, for the same reason.
 *
 * The identity case returns the block's own array rather than a copy. Nothing
 * downstream mutates it, and the alternative is a needless pass over up to 16 M
 * cells on the single commonest path there is — a reader who asked for none of
 * this.
 */
export function deriveBlock(
  block: BlockValues,
  derivation: Derivation,
  runs: { rows: readonly AxisRun[]; cols: readonly AxisRun[] },
): DerivedValues {
  const parts: string[] = []
  let scope: string | null = null
  let values = block.values

  switch (derivation.normalise) {
    case 'vc':
      values = coverageNormalise(block, 1)
      parts.push('VC')
      break
    case 'vcsqrt':
      values = coverageNormalise(block, 0.5)
      parts.push('VC √')
      break
    case 'ice': {
      const balanced = balanceBlock(block)
      values = balanced.values
      parts.push('ICE')
      // Said rather than hidden: a partly-converged scaling is a better picture
      // than raw counts and a worse one than the label promises, and the reader
      // is the one who can decide whether that matters.
      if (!balanced.converged) scope = 'stopped before convergence — block too large'
      break
    }
    default:
      break
  }

  if (derivation.expected === true) {
    const stepped = { ...block, values }
    values = observedOverExpected(stepped, runs)
    parts.push('O/E')
  }

  return {
    values,
    // Only the baseline produces a middle. A normalisation rescales a count and
    // leaves it a count — still a quantity with a floor at zero — which is why
    // `VC` alone stays on a sequential ramp and `O/E` does not.
    neutral: derivation.expected === true ? 1 : null,
    label: parts.length === 0 ? 'counts' : parts.join(' · '),
    scope,
  }
}

/**
 * The transform a derived quantity should be read on, where it has an opinion.
 *
 * A ratio wants `log2`, so that twice and half are the same distance either side
 * of neutral; a difference is already symmetric and wants none. Offered as a
 * *default* the panel adopts on the way in and gives back on the way out —
 * nothing here forbids reading a ratio on a linear scale, it only refuses to
 * make that the thing a reader is shown without asking.
 */
export function preferredTransform(neutral: number | null): 'log2' | 'none' | null {
  if (neutral === null) return null
  return neutral === 1 ? 'log2' : 'none'
}

/** The largest bin separation any cell of the block can have. */
function maxSeparation(rowStart: number, nrows: number, colStart: number, ncols: number): number {
  const a = Math.abs(rowStart - (colStart + Math.max(0, ncols - 1)))
  const b = Math.abs(rowStart + Math.max(0, nrows - 1) - colStart)
  return Math.max(a, b)
}

/**
 * The sequence each row or column belongs to, as an index into the run array.
 *
 * Compared by *label* rather than by run index, because the two axes of a
 * rectangular block have two different run arrays and run 0 of one is not run 0
 * of the other. `null` is "no run covers this index", which compares equal to
 * itself and so keeps an unlabelled block on the cis curve — the right answer
 * for a plain cooler read as one span, where every cell is within one sequence.
 */
function labelsByIndex(runs: readonly AxisRun[], length: number): Array<string | null> {
  const out = new Array<string | null>(length).fill(null)
  for (const run of runs) {
    const end = Math.min(run.end, length)
    for (let i = Math.max(0, run.start); i < end; i++) out[i] = run.label
  }
  return out
}
