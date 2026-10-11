/**
 * Despeckling: each cell replaced by the mean of its neighbours.
 *
 * A contact map at a fine bin size is counting Poisson noise as much as it is
 * counting contacts. At 5 kb on a bacterial genome about a tenth of the cells
 * are empty and most of the rest hold single digits, so a *ratio* of two such
 * maps is dominated by the arithmetic of small integers: `3 / 1` is a threefold
 * enrichment and `1 / 0` is an infinite one, and neither is a finding. The
 * picture that results is a haze of saturated single pixels with the structure
 * somewhere underneath it.
 *
 * The fix is the oldest one there is — average over a `(2r+1)²` neighbourhood of
 * uniform weights, `terra::focal` in R, the filter Hi-C figures are usually made
 * with.
 *
 * **The cell counts as one of its own neighbours, and that was not always so.**
 * This filter began with the centre weight set to zero, on the argument that a
 * cell disagreeing with all eight of its neighbours is evidence about the
 * neighbourhood rather than about itself, and that a kernel keeping a ninth of
 * its own value carries a wild pixel into the result at a ninth strength instead
 * of removing it.
 *
 * That argument is right about *outlier rejection* and wrong about everything
 * else this filter is now asked to do, and on a sparse map it fails visibly. A
 * lone contact in an empty neighbourhood is not an outlier — it is the only
 * measurement there is — and a zero-centre kernel replaces it with the mean of
 * the eight zeros around it while spreading it into those eight, so every
 * isolated count renders as a **hollow square with a hole where the contact
 * actually was**. At 500 bp most of a map away from the diagonal is made of
 * exactly those cells, so most of the picture became rings.
 *
 * It is also wrong for the arithmetic downstream. What this filter now produces
 * is a local *rate*, which `render/derive.ts` divides by an expected curve, and
 * an estimator that discards the one cell it is estimating at is both biased and
 * needlessly noisy: it throws away a ninth of its own sample to reject an
 * outlier nobody asked it to reject.
 *
 * So the centre is in, and the despeckling survives the change in all but the
 * narrowest window: a wild pixel is diluted to a ninth of its excess at `3 × 3`,
 * a twenty-fifth at `5 × 5`, and to a few hundredths at the widths the adaptive
 * settings reach. What is lost is the guarantee that a single wild cell is
 * annihilated rather than merely suppressed, and what is bought is that a single
 * *real* cell is no longer annihilated either.
 *
 * **Two passes, and a kernel with a shoulder.** The adaptive filter below reads
 * the block twice. The first pass measures every cell against its own
 * neighbourhood *excluding itself* and caps what one cell may contribute
 * ({@link LEVERAGE}); the second averages the capped field over three nested
 * windows rather than one. Both exist for the same reported defect: a box mean
 * has no defence against a single wild cell, and a box kernel's impulse response
 * *is* a box, so one hot pixel raised every window that reached it by the same
 * amount and none of the next ones along — a hard-edged rectangle that read as
 * structure. Measured on a yeast map at 500 bp, one cell at 400× its
 * neighbourhood produced a 20 × 20 bin block saturating the `log2` scale; with
 * both in place a synthetic spike of that size no longer reaches the clip and the
 * O/E's mean stays at 1.00 in every separation band.
 *
 * **Both reduce the artefact rather than removing it, and it is still visible on
 * real data.** The cap bounds a flagged cell by construction — {@link LEVERAGE}
 * permits it to inflate its window by half — and two stricter responses were
 * written and dropped: trimming the cell out of the sum and the divisor, and
 * replacing it with its eight neighbours' mean. Both improved the planted-spike
 * case and neither removed the artefact reproducibly on a real map. That points
 * at the **detector** rather than the response, and at the synthetic used here as
 * not reproducing whatever the real one is: the next attempt should start from a
 * real block that shows it, not from a spike put in on purpose.
 *
 * **Where it sits matters more than the kernel does.** This is applied per file,
 * before two files are combined (`render/derive.ts`, `ui/MapDerivation.ts`), so a
 * ratio is `smooth(A) / smooth(B)` and never `smooth(A / B)`. The two are not
 * variations on one idea. Smoothing the ratio has to average `Infinity` and `0`
 * — the answers `x / 0` and `0 / x` give — and one infinite cell poisons every
 * window it falls in; smoothing the inputs makes those cells finite *before* the
 * division, because a zero cell with contacts around it is no longer zero. The
 * speckle does not get blurred, it stops being produced.
 *
 * Two further departures from `terra::focal`, both about edges:
 *
 * 1. **The divisor is the number of cells that contributed**, not the fixed
 *    `(2r+1)²`. `terra::focal` pads with `NA` and `na.rm = TRUE` drops them
 *    from the sum while the weights stay put, so a cell on the boundary is
 *    divided by a count of neighbours it did not have and comes out low. In a
 *    figure that is a dark frame a reader crops off. Here the boundary is the
 *    *viewport*, so it would be a dark frame that moved when the map was panned.
 *
 * 2. **A cell with no value keeps none.** `NaN` is what an unbalanced bin leaves
 *    behind (§6.4) and what `0 / 0` produces, and both mean "there is nothing to
 *    report here". `na.rm = TRUE` would fill those from the neighbours, painting
 *    a measurement over the one place the map is saying it has none.
 */

/**
 * The part of a block this module needs: shape and values.
 *
 * Structurally `render/derive.ts`'s `BlockValues`, and declared here rather than
 * imported from it for one reason: `deriveBlock` calls into this file, so an
 * import the other way would put a cycle in the module graph to carry a type
 * that is erased at compile time. The same reason `derive.ts` declares its own
 * `AxisRun` instead of importing the wire format's.
 */
interface Cells {
  nrows: number
  ncols: number
  values: Float32Array
}

/**
 * The radii offered, as `(2r+1) × (2r+1)` windows. `0` is off.
 *
 * Stopping at 3 is not a technical limit — the filter is O(1) per cell in the
 * radius — but a statement about what the operation is for. A 7 × 7 window
 * already averages 48 cells, which at a fine bin size is most of a
 * near-diagonal feature; anything wider is asking for a coarser bin size, and
 * that is a better way to get one because it also reads less.
 */
export const SMOOTH_RADII: readonly number[] = [0, 1, 2, 3]

/** `3 × 3` for radius 1 — the window, which is what a reader is choosing. */
export function smoothLabel(radius: number): string {
  return `${radius * 2 + 1} × ${radius * 2 + 1}`
}

/**
 * Replace every cell by the mean of the cells around it, itself included.
 *
 * Returns the block's own array untouched at radius `0`, which is the path
 * every reader who has not asked for this takes.
 *
 * Separable and incremental, so the cost is independent of the radius: a column
 * of running sums is carried down the block, one row entering and one leaving
 * per step, and a window slides along it across each row. The alternative —
 * `(2r+1)²` reads per cell — is 49 passes over a 16 M-cell block at radius 3,
 * which is a visible freeze on a toggle that is supposed to feel like a colour
 * change. Extra memory is two arrays the width of the block rather than two
 * copies of it, which matters at the 4096² cap where a copy is 67 MB.
 *
 * Sums are `Float64` where the values are `Float32`. A running window adds and
 * subtracts the same cell thousands of times over a wide block, and single
 * precision drifts visibly under that; double precision does not, and the
 * intermediates are two rows rather than two blocks so it costs nothing worth
 * counting.
 */
export function smoothValues(block: Cells, radius: number): Float32Array {
  const { nrows, ncols, values } = block
  if (!(radius >= 1) || nrows === 0 || ncols === 0) return values

  const span = Math.floor(radius)
  const out = new Float32Array(nrows * ncols)
  // What is in the vertical window, per column: the sum of the finite values and
  // how many there were. Both are needed — the count is the divisor, and it is
  // not `2 * span + 1` at the top and bottom edges or anywhere a bin was
  // discarded by the balancer.
  const colSum = new Float64Array(ncols)
  const colCount = new Int32Array(ncols)

  const shiftRow = (row: number, sign: 1 | -1): void => {
    if (row < 0 || row >= nrows) return
    const base = row * ncols
    for (let c = 0; c < ncols; c++) {
      const v = values[base + c]
      // Non-finite and not only `NaN`: an `Infinity` added here could never be
      // subtracted back out, and the running sum would be `NaN` for every
      // remaining row of the block.
      if (!Number.isFinite(v)) continue
      colSum[c] += sign * v
      colCount[c] += sign
    }
  }

  for (let r = 0; r <= span && r < nrows; r++) shiftRow(r, 1)

  for (let i = 0; i < nrows; i++) {
    if (i > 0) {
      shiftRow(i - span - 1, -1)
      shiftRow(i + span, 1)
    }

    let sum = 0
    let count = 0
    for (let c = 0; c <= span && c < ncols; c++) {
      sum += colSum[c]
      count += colCount[c]
    }

    const base = i * ncols
    for (let c = 0; c < ncols; c++) {
      if (c > 0) {
        const gone = c - span - 1
        if (gone >= 0) {
          sum -= colSum[gone]
          count -= colCount[gone]
        }
        const come = c + span
        if (come < ncols) {
          sum += colSum[come]
          count += colCount[come]
        }
      }

      const centre = values[base + c]
      if (Number.isNaN(centre)) {
        // Nothing to report here, and a neighbourhood mean is not a report.
        out[base + c] = Number.NaN
        continue
      }
      // The centre counts as one of its own neighbours: it is already in `sum`
      // and in `count`, and nothing is taken back out. An **infinite** centre
      // never entered either, so it is still replaced by the cells around it
      // rather than left as the one thing the filter could not touch.
      out[base + c] = count > 0 ? sum / count : centre
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// The window that sizes itself
// ---------------------------------------------------------------------------

/**
 * Why a fixed window stops working away from the diagonal.
 *
 * The filter above averages a fixed `(2r+1)²` box, and the precision of that
 * average depends on the **counts** it covers rather than on the number of cells
 * it covers. Near the diagonal a 7 × 7 box holds thousands of contacts and its
 * mean is steady. At 300 kb separation in the same map the same 48 cells are
 * almost all zero, so the mean is a handful of counts divided by 48 — still
 * noise, and widening to 9 × 9 does not help because the box grows 1.7× while
 * what is in it grows 1.7× from nearly nothing.
 *
 * That is the observation serpentine (Baudry *et al.*, *Bioinformatics* 2020)
 * is built on, and its answer is to hold the counts constant instead of the
 * window: grow a region until it clears a threshold, then average it. The
 * regions are grown by random agglomeration over the whole square, which makes
 * the result a partition — good for a differential analysis, and awkward for a
 * viewer, because the partition is global and stochastic, so panning by one bin
 * redraws every boundary and the map visibly reshuffles under the reader.
 *
 * What follows takes serpentine's criterion and keeps this file's locality: a
 * cell's window grows until it covers enough signal, and nothing else about the
 * cell's value depends on the rest of the block. A cell therefore reads the same
 * whether it is in the middle of the viewport or at its edge, which is what lets
 * a reader pan a smoothed map and believe what moves. It is a variable-bandwidth
 * kernel smoother, not a binning: windows overlap and no partition is formed, so
 * there are no region boundaries to see and none to keep stable.
 *
 * **The bandwidth is measured on the values as they were read**, not on the
 * derived ones, and that is the same separation serpentine makes when it
 * thresholds on counts and reports a ratio. Observed-over-expected is near 1
 * everywhere by construction — that is what dividing out the distance decay is
 * *for* — so a window sized on it would be the same size everywhere and the
 * whole exercise would collapse. Sized on counts it grows exactly where the
 * counts thin out, which is where the O/E is noisiest.
 */

/** How much smoothing a reader asked for: a fixed window, or a target to reach. */
export type Smoothing =
  | { kind: 'fixed'; radius: number }
  | {
      kind: 'adaptive'
      /**
       * Signal each window must cover, in multiples of the block's mean cell.
       *
       * Expressed as a multiple rather than as an absolute count because the
       * cells reaching this stage are not always counts: `score` may have put
       * balanced values in them (§6.4), which are the same measurement rescaled
       * by a factor no part of this module can see. A criterion in absolute
       * counts would be met by one cell on a raw map and by no window at all on
       * a balanced one. Against the block's own mean it means the same thing on
       * both — *cover this many average cells' worth of evidence* — and it
       * reduces to serpentine's threshold on counts when the cells are counts.
       */
      target: number
      /**
       * The smallest window it may use, where the data is already rich enough.
       *
       * Without a floor, a cell sitting on a strong near-diagonal feature clears
       * the target inside a single cell and is left unsmoothed, so the setting
       * would do nothing at all along the diagonal and everything away from it.
       * With one, it is `3 × 3` or wider and never narrower — the fixed setting
       * above it in the picker, widening where the counts thin out.
       */
      floor: number
      /** What the caption calls it. */
      name: string
    }

/**
 * The widest window a cell may grow to, as a radius.
 *
 * A cell that has not met its target by here keeps this width and stays noisy,
 * which is the honest outcome: the alternative is a window growing without limit
 * until it has averaged the map into its own mean, and a flat field is not a
 * better picture of thin data than a noisy one.
 *
 * It was 64, and 64 was too low: on a yeast map at 500 bp the window ran into the
 * cap beyond about 200 bins of separation, so the cap rather than the target was
 * choosing the width for exactly the cells with the least data. At 192 the target
 * is what decides, which is the whole point of the setting.
 *
 * The search is a binary one, so the cost of raising it is a fourth trial radius
 * per cell and nothing else; the ceiling is about meaning rather than time. It is
 * still clamped to the block, so a small block cannot ask for a window larger
 * than itself.
 */
export const ADAPTIVE_MAX_RADIUS = 192

/**
 * The largest block the adaptive filter will run on, in cells.
 *
 * 16 M cells is a 4096² block, which is the raster cap — so in practice the
 * setting is available on anything the viewer will draw, including a whole
 * chromosome at a fine bin size and a whole small genome. Earlier limits of 2 M
 * and 4 M fell in the worst possible place: they fitted the small yeast
 * chromosomes at 1 kb and refused the large ones, so the setting worked on
 * fifteen chromosomes of a genome and not on the sixteenth.
 *
 * What used to make a cap necessary was memory, and {@link STRIP_ENTRIES} is why
 * it no longer sets one: the cumulative tables are built for a band of rows at a
 * time rather than for the block, so what is resident is 128 MB whatever the
 * block's size. The cap that remains is about **time**, measured on the thread
 * drawing frames:
 *
 * | block | cells | time |
 * |---|---|---|
 * | 353² | 0.12 M | 78 ms |
 * | 841² | 0.7 M | 300 ms |
 * | 1,200² | 1.4 M | 574 ms |
 * | 2,000² | 4 M | 1.5 s |
 * | 4,096² | 16 M | **7.4 s** |
 *
 * Roughly linear, and about twice what it was before the winsorising pass, which
 * reads the block a second time. The last row is the honest cost of the cap being
 * where it is: a reader who picks this on the largest block the viewer draws waits
 * seven seconds with the window blocked. A whole chromosome at 1 kb is under a
 * second. If that last row ever needs to stop being a freeze, the answer is the
 * analysis thread rather than a lower cap — the work is a pure function of two
 * arrays.
 *
 * Above it the picker's choice is honoured at its {@link Smoothing.floor} and
 * the caption and the view note both say so.
 *
 * Above it the picker's choice is honoured at its {@link Smoothing.floor} and
 * the caption says so, which is the same refusal the correlation makes: a real
 * picture, and a caption that does not claim to be the one that was asked for.
 */
export const MAX_ADAPTIVE_CELLS = 16_000_000

/**
 * The largest block this is worth computing on the thread drawing frames.
 *
 * Below it the filter is a hitch on a dropdown — 78 ms on a 353² view, 400 ms at
 * this limit — and doing it inline keeps the map from flashing unsmoothed on the
 * way to being smoothed. Above it the cost climbs past a second and reaches 7.4 s
 * at {@link MAX_ADAPTIVE_CELLS}, which is a frozen window, so a caller that can
 * run the work elsewhere is handed the arrays instead
 * (`render/derive.ts`'s `SmoothingRequest`).
 *
 * The fixed radii never defer at any size: they are one incremental pass over the
 * cells, and 20 ms is not worth a round trip.
 */
export const SMOOTH_INLINE_CELLS = 1_000_000

/** The dropdown, in order: what it says and what it means. */
export interface SmoothChoice {
  /** Stable identity, carried in the link. */
  id: string
  /** What the picker shows. */
  label: string
  /** `null` for `off`. */
  smoothing: Smoothing | null
}

/**
 * What the picker offers.
 *
 * The fixed radii keep the ids they have always had — `1`, `2`, `3` — so a link
 * written before this existed still means what it meant. The adaptive settings
 * are `a` and their target, which keeps the hash legible for the same reason
 * every other key in it is legible: somebody has to be able to read a link and
 * see what picture it asks for.
 *
 * One adaptive setting rather than a ladder of them, because the target is not a
 * quantity a reader has any way to choose and three strengths of it were three
 * ways to ask the same question. What is offered is the one that keeps the most
 * detail: on a yeast map at 500 bp it runs 3 × 3 along the diagonal and 21 × 21
 * at 200 bins out, which is the fixed `3 × 3` where the data is rich and much
 * wider where it is not.
 */
export const SMOOTH_CHOICES: readonly SmoothChoice[] = [
  { id: '0', label: 'off', smoothing: null },
  // Spread from {@link SMOOTH_RADII} rather than written out again, so the
  // radii this build offers are still stated in exactly one place.
  ...SMOOTH_RADII.filter((radius) => radius > 0).map((radius) => ({
    id: String(radius),
    label: smoothLabel(radius),
    smoothing: { kind: 'fixed' as const, radius },
  })),
  {
    id: 'a50',
    label: 'adaptive',
    smoothing: { kind: 'adaptive', target: 50, floor: 1, name: 'adaptive' },
  },
]

/**
 * What a reader asked for, from the token a link or a picker carries.
 *
 * `null` for off and for anything unrecognised, which is the rule the rest of
 * the view state follows: a hash asking for something this build does not have
 * lands on the plain map rather than on a guess at what was meant. Numbers are
 * accepted beside strings because the setting was a radius before it was a
 * choice, and `smooth=2` in an old link is still a legal way to ask for 5 × 5.
 */
export function parseSmooth(token: number | string | undefined): Smoothing | null {
  if (token === undefined || token === '') return null
  const id = String(token)
  return SMOOTH_CHOICES.find((choice) => choice.id === id)?.smoothing ?? null
}

/** The token that names a setting, for the link and the picker. */
export function smoothToken(smoothing: Smoothing | null): string {
  if (smoothing === null) return '0'
  const same = (offered: Smoothing): boolean =>
    smoothing.kind === 'fixed'
      ? offered.kind === 'fixed' && offered.radius === smoothing.radius
      : offered.kind === 'adaptive'
  return SMOOTH_CHOICES.find((choice) => choice.smoothing !== null && same(choice.smoothing))?.id ?? '0'
}

/**
 * What the colourbar caption calls a setting.
 *
 * The adaptive setting says `adaptively` rather than a window size because there
 * is no one window to name — the point of it is that the number varies across the
 * picture — and a caption naming the widest or the commonest would be the one
 * part of the figure that survives an export saying something that is not true of
 * most of it.
 */
export function smoothingCaption(smoothing: Smoothing): string {
  return smoothing.kind === 'fixed' ? smoothLabel(smoothing.radius) : 'adaptively'
}

/**
 * Entries one cumulative table may hold at once, which is what bands the work.
 *
 * 4 M `Float64` entries is 32 MB a table, so the four of them are 128 MB
 * resident — allocated and freed inside one derivation, on the thread drawing
 * frames. The alternative is a table the size of the block, which at the 16 M
 * cell cap is 128 MB *each* and over half a gigabyte together.
 */
const STRIP_ENTRIES = 4_000_000

/**
 * How much of a window's mean one cell of it may be responsible for.
 *
 * **Not a multiple of the local mean**, which is the obvious rule and is wrong
 * for this data. Away from the diagonal a contact map is Poisson-sparse: the
 * mean over a window is 0.05 while the occupied cells in it hold 1, so *every*
 * real count is twenty times the local mean. A cap of `k × mean` either sits low
 * enough to delete all of them — biasing the sparsest part of the map downward,
 * which is the part the filter exists for — or high enough to let a hot pixel
 * through. There is no `k` that does both.
 *
 * What the artefact actually is, is **leverage**: a cell raises the mean of every
 * window that reaches it by `(value − mean) / n`, and a box kernel gives it that
 * leverage over every one of those windows equally. So the cap is written on the
 * leverage directly — no cell may add more than half again to the mean of a
 * window its own size:
 *
 * ```
 * cap = mean_without_it × (1 + LEVERAGE × cells_in_window)
 * ```
 *
 * That scales itself. Near the diagonal a window is 3 × 3 and the cap is 5.5×
 * the neighbours, tight enough to hold a sharp feature to something its
 * neighbours corroborate. In a sparse region the window is 21 × 21 and the cap is
 * 200× the local mean, which leaves every honest isolated count alone and still
 * cuts a cell of four hundred to single digits.
 *
 * The mean is taken **without the cell itself**, which is the one place the old
 * zero-centre kernel was right: excluding the centre is the correct thing for
 * deciding whether a cell is an outlier, and the wrong thing for estimating what
 * should be drawn there. Both are done here, one in each pass.
 */
const LEVERAGE = 0.5

/** A cumulative table and the row stride its box queries need. */
interface Summed {
  table: Float64Array
  /** `ncols + 1`. */
  stride: number
  /** The block row this table's first row stands for — see {@link summed}. */
  origin: number
}

/**
 * Cumulative sums over the block, so that any box costs four reads.
 *
 * The alternative is the incremental window {@link smoothValues} uses, which
 * carries running sums down the block and is cheaper still — but only for *one*
 * radius. Here every cell wants a different one, and re-running that pass for
 * each of the 64 radii on offer would be 64 passes over the block to serve a
 * handful of cells at the wide end. A summed-area table answers every radius
 * from one pass, which is what makes the search below affordable.
 *
 * `Float64` and not `Float32`, and the reason is the subtraction rather than the
 * sum: entries near the far corner are the total over the whole block, and a box
 * of a few cells is the difference of four such numbers. In single precision
 * that difference is quantised to the size of the total — around 1 for a block
 * summing to 16 M — so a window mean would come back as an integer-ish value
 * with no signal left in it. The tables are the block's size, which is what
 * {@link MAX_ADAPTIVE_CELLS} exists to bound.
 */
function summed(
  rowFrom: number,
  rowTo: number,
  ncols: number,
  contribution: (index: number) => number,
): Summed {
  const stride = ncols + 1
  const rows = rowTo - rowFrom + 1
  const table = new Float64Array((rows + 1) * stride)
  for (let k = 0; k < rows; k++) {
    const above = k * stride
    const here = (k + 1) * stride
    const base = (rowFrom + k) * ncols
    let running = 0
    for (let c = 0; c < ncols; c++) {
      running += contribution(base + c)
      table[here + c + 1] = table[above + c + 1] + running
    }
  }
  return { table, stride, origin: rowFrom }
}

/** The sum over rows `r0..r1` and columns `c0..c1`, both inclusive. */
function box(s: Summed, r0: number, c0: number, r1: number, c1: number): number {
  const { table, stride, origin } = s
  const top = (r0 - origin) * stride
  const bottom = (r1 - origin + 1) * stride
  return table[bottom + c1 + 1] - table[top + c1 + 1] - table[bottom + c0] + table[top + c0]
}

/**
 * Replace every cell by the mean of a window grown until it covers enough
 * evidence.
 *
 * `counts` is the block as it was read — the array whose thinning-out with
 * distance is the thing being compensated for — while `block.values` is what
 * gets averaged, which is whatever the derivation has made of it by now. Keeping
 * them apart is the whole design: see the note above {@link Smoothing}.
 *
 * The search is a binary one over the radius, which is sound because the
 * window sums are non-decreasing in it — negative cells are floored at zero on
 * the way into the table for exactly that reason. A `/pixels` column is allowed
 * to hold negative numbers (`render/derive.ts` says so), and one that did would
 * otherwise make a wider window cover *less* evidence than a narrow one and turn
 * the search into a guess. Floored, such a cell contributes no evidence of
 * coverage, which is the only thing this table is asked about.
 *
 * Everything the fixed filter decided about edges and gaps is decided the same
 * way here, because they are the same questions: the divisor is the number of
 * cells that actually contributed rather than the window's nominal size, the
 * centre is one of them, a `NaN` centre stays `NaN` because an unbalanced bin
 * has nothing to report, and a non-finite centre is replaced by its neighbours
 * rather than left as the one cell the filter could not touch.
 */
export function adaptiveSmoothValues(
  block: Cells,
  counts: Float32Array,
  smoothing: Extract<Smoothing, { kind: 'adaptive' }>,
  /**
   * A second field averaged over **the same windows**, for a caller that is
   * about to divide by it.
   *
   * Dividing a smoothed map by an unsmoothed baseline is not the same operation
   * and is not a safe one: near the diagonal the decay is steep, so a window
   * that spans it averages cells whose baselines differ several-fold, and the
   * ratio comes out systematically high — a measured 24-32% enrichment at radii
   * 3 to 7 that is an artefact of the filter and nothing else. Averaged over the
   * same cells with the same divisor, the bias is in both halves of the ratio
   * and cancels, and the mean sits back at 1 where an O/E belongs.
   */
  over?: Float32Array,
): {
  values: Float32Array
  /** `null` unless {@link over} was given. */
  over: Float32Array | null
  applied: Smoothing
  scope: string | null
} {
  const { nrows, ncols, values } = block
  const floor = Math.max(1, Math.floor(smoothing.floor))
  const fell = { kind: 'fixed', radius: floor } as const
  // The floor applied to both fields, for the paths that cannot adapt. The
  // companion goes through the same filter at the same radius, so a caller
  // dividing one by the other still gets matched windows.
  const bothAtFloor = (): { values: Float32Array; over: Float32Array | null } => ({
    values: smoothValues(block, floor),
    over: over === undefined ? null : smoothValues({ ...block, values: over }, floor),
  })
  if (nrows === 0 || ncols === 0) {
    return { values, over: over ?? null, applied: smoothing, scope: null }
  }

  if (nrows * ncols > MAX_ADAPTIVE_CELLS) {
    return {
      ...bothAtFloor(),
      // What the caption will say, and it says the window that was *used*. A
      // figure captioned `adaptively` whose windows were all one size would be
      // the refusal reaching the one place a refusal must never reach.
      applied: fell,
      // Named in the caption rather than swallowed, on the correlation's rule: a
      // fixed despeckle is a real picture and looks like one, so nothing else on
      // screen would betray that it is not the one that was asked for.
      scope: `adaptive smoothing not applied — block too large`,
    }
  }

  // The block's mean cell, which is what the target is a multiple of. Measured
  // on the counts and over the finite cells only, so that a map whose bins were
  // mostly discarded by the balancer is scaled by what it has rather than by how
  // much of it is missing.
  let total = 0
  let seen = 0
  // Bounded by the block rather than by the array, which is documented as *at
  // least* that long: a padded tail averaged in here would move the scale every
  // window on the picture is sized against.
  const cells = nrows * ncols
  for (let i = 0; i < cells; i++) {
    const v = counts[i]
    if (Number.isFinite(v) && v > 0) {
      total += v
      seen++
    }
  }
  const scale = seen > 0 ? total / seen : 0
  // Nothing to size a window against: an empty block, or one whose every cell is
  // missing. The floor is what the reader asked for anyway, and there is no
  // adaptation to report the absence of — every window would be the floor.
  if (!(scale > 0)) return { ...bothAtFloor(), applied: fell, scope: null }

  const threshold = smoothing.target * scale
  const maxRadius = Math.min(ADAPTIVE_MAX_RADIUS, Math.max(nrows, ncols))

  // One mask for every table below, and it has to be one: the bias only cancels
  // out of the ratio if the two fields were averaged over exactly the same cells
  // with exactly the same divisor. A cell missing from either field is missing
  // from both.
  const usable = (i: number): boolean =>
    Number.isFinite(values[i]) && (over === undefined || Number.isFinite(over[i]))

  // **The tables are built for a band of rows at a time, not for the block.**
  // They are the block's size and `Float64`, so at the 16 M cap the four of them
  // would be over half a gigabyte allocated on the thread drawing frames. A cell
  // only ever reads rows within `maxRadius` of itself, so a band of `stripRows`
  // output rows needs `stripRows + 2 · maxRadius` table rows and nothing more.
  // Rows in the overlap are built twice, which is the whole cost: about 1.6× the
  // table-building work at a band that holds a few hundred rows, against a
  // fivefold cut in what is resident at once.
  const stripRows = Math.max(1, Math.floor(STRIP_ENTRIES / (ncols + 1)) - 2 * maxRadius)
  // A block far wider than it is tall cannot be banded usefully — its bands are
  // already the whole of it — so what would have been allocated is checked
  // rather than assumed. This is the shape guard the cell cap alone cannot make.
  const bandRows = Math.min(nrows, stripRows + 2 * maxRadius + 1)
  if (bandRows * (ncols + 1) > STRIP_ENTRIES * 2) {
    return {
      values: smoothValues(block, floor),
      applied: fell,
      over: over === undefined ? null : smoothValues({ ...block, values: over }, floor),
      scope: `adaptive smoothing not applied — block too large`,
    }
  }

  /** The band boundaries, shared by both passes so the two see the same rows. */
  const bands: Array<[number, number, number, number]> = []
  for (let top = 0; top < nrows; top += stripRows) {
    const bottom = Math.min(nrows - 1, top + stripRows - 1)
    // Everything any row of this band can see, clamped to the block. A window is
    // clamped to the block too, so clamping to the band is the same thing.
    bands.push([top, bottom, Math.max(0, top - maxRadius), Math.min(nrows - 1, bottom + maxRadius)])
  }

  /**
   * The window this cell's own neighbourhood justifies, walked from the last
   * answer rather than bisected.
   *
   * The criterion is monotone in the radius — evidence is floored at zero on the
   * way into the table for exactly that reason — so a walk and a bisection find
   * the same width, and a bisection costs its eight probes on every cell however
   * smooth the field is. Radii vary slowly from one cell to the next.
   */
  const search = (
    evidence: Summed,
    r: number,
    c: number,
    from: number,
    to: number,
    start: number,
  ): number => {
    const covers = (rad: number): boolean => {
      const r0 = r - rad < from ? from : r - rad
      const c0 = c - rad < 0 ? 0 : c - rad
      const r1 = r + rad > to ? to : r + rad
      const c1 = c + rad >= ncols ? ncols - 1 : c + rad
      return box(evidence, r0, c0, r1, c1) >= threshold
    }
    let rad = start < floor ? floor : start > maxRadius ? maxRadius : start
    if (covers(rad)) {
      while (rad > floor && covers(rad - 1)) rad--
    } else {
      while (rad < maxRadius && !covers(rad)) rad++
    }
    return rad
  }

  /** The mean of one field over the window, and the cells that contributed. */
  const windowMean = (
    field: Summed,
    counted: Summed,
    r: number,
    c: number,
    rad: number,
    from: number,
    to: number,
  ): number => {
    const r0 = r - rad < from ? from : r - rad
    const c0 = c - rad < 0 ? 0 : c - rad
    const r1 = r + rad > to ? to : r + rad
    const c1 = c + rad >= ncols ? ncols - 1 : c + rad
    const n = box(counted, r0, c0, r1, c1)
    return n > 0 ? box(field, r0, c0, r1, c1) / n : Number.NaN
  }

  // -------------------------------------------------------------------------
  // Pass one: what each cell's neighbourhood looks like, so the cell can be
  // measured against it
  // -------------------------------------------------------------------------

  /**
   * `values`, with no cell allowed to stand more than {@link WINSOR_FACTOR}
   * above the mean of its own window.
   *
   * A mean has no defence against one wild number, and this filter had one until
   * the centre went back into the kernel — a lone hot cell used to be annihilated
   * and is now averaged in at full weight. On a sparse map far from the diagonal
   * that is a visible defect rather than a subtlety: a single cell a few hundred
   * times its surroundings raises the whole window's mean, and because the kernel
   * is a box, *every* cell whose window reaches it is raised by the same amount.
   * A point becomes a **hard-edged rectangle** — measured at 20 × 20 bins for one
   * cell at 400× its neighbourhood, at a peak of 5.3 in `log2` O/E, where the
   * scale clips at 0.84.
   *
   * Capping against the cell's *own neighbourhood* rather than against the
   * distance model is the part that matters. A real loop is precisely a cell far
   * above what its separation predicts, so a cap of `k × expected` would erase
   * the findings; a cap of `k × local mean` keeps them, because the neighbours
   * that make a loop a loop raise the mean with it.
   *
   * The mean it is measured against is itself slightly inflated by the outlier,
   * which is a self-limiting problem rather than a circular one: the cell enters
   * that mean divided by the window's cell count and leaves it multiplied by
   * `k`, so a 400× spike in a 529-cell window is compared against a mean it
   * lifted by 90% and is still cut by a factor of forty.
   */
  const capped = new Float32Array(nrows * ncols)
  for (const [top, bottom, from, to] of bands) {
    const evidence = summed(from, to, ncols, (i) => {
      const v = counts[i]
      return Number.isFinite(v) && v > 0 ? v : 0
    })
    const sums = summed(from, to, ncols, (i) => (usable(i) ? values[i] : 0))
    const seenCells = summed(from, to, ncols, (i) => (usable(i) ? 1 : 0))

    let rowStart = floor
    for (let r = top; r <= bottom; r++) {
      const base = r * ncols
      let radius = rowStart
      for (let c = 0; c < ncols; c++) {
        const centre = values[base + c]
        if (!usable(base + c)) {
          capped[base + c] = centre
          continue
        }
        radius = search(evidence, r, c, from, to, radius)
        if (c === 0) rowStart = radius

        const r0 = r - radius < from ? from : r - radius
        const c0 = c - radius < 0 ? 0 : c - radius
        const r1 = r + radius > to ? to : r + radius
        const c1 = c + radius >= ncols ? ncols - 1 : c + radius
        const n = box(seenCells, r0, c0, r1, c1) - 1
        const without = n > 0 ? (box(sums, r0, c0, r1, c1) - centre) / n : 0
        // Nothing around it to be an outlier against. A cap of zero would delete
        // a measurement rather than moderate one, and a cell whose whole window
        // is empty is the only evidence there is about that place.
        capped[base + c] =
          without > 0 ? Math.min(centre, without * (1 + LEVERAGE * n)) : centre
      }
    }
  }

  // -------------------------------------------------------------------------
  // Pass two: the tapered mean of the capped field
  // -------------------------------------------------------------------------

  const out = new Float32Array(nrows * ncols)
  const outOver = over === undefined ? null : new Float32Array(nrows * ncols)

  for (const [top, bottom, from, to] of bands) {
    const evidence = summed(from, to, ncols, (i) => {
      const v = counts[i]
      return Number.isFinite(v) && v > 0 ? v : 0
    })
    const sums = summed(from, to, ncols, (i) => (usable(i) ? capped[i] : 0))
    const overSums =
      over === undefined ? null : summed(from, to, ncols, (i) => (usable(i) ? over[i] : 0))
    const seenCells = summed(from, to, ncols, (i) => (usable(i) ? 1 : 0))

    let rowStart = floor
    for (let r = top; r <= bottom; r++) {
      const base = r * ncols
      let radius = rowStart
      for (let c = 0; c < ncols; c++) {
        const centre = values[base + c]
        if (Number.isNaN(centre)) {
          out[base + c] = Number.NaN
          if (outOver !== null) outOver[base + c] = Number.NaN
          continue
        }

        // The narrowest window that covers the target, never below the floor and
        // never above the cap. A cell that cannot reach it inside the cap keeps
        // the cap, which is the widest honest answer available to it.
        radius = search(evidence, r, c, from, to, radius)
        if (c === 0) rowStart = radius

        // **Three nested windows, averaged.** A single box is the reason a point
        // becomes a rectangle: its impulse response *is* a box, so a cell that
        // enters the window contributes the same amount to every output cell
        // that can see it and nothing at all to the next one along. Averaging
        // the means of boxes at `r/2`, `r` and `3r/2` puts a step in the weights
        // instead of a cliff — the outermost shell carries about 8% of the
        // weight the centre does, so a residual outlier fades out rather than
        // ending at a straight edge that reads as structure.
        //
        // The radii are chosen so the taper costs nothing in noise. Spreading the
        // weight outward lowers the effective sample size for a given extent, and
        // `(r/2, r, 3r/2)` gives an effective count of 3.90·r² against the plain
        // box's 4·r² — the same estimate, over half again as much ground.
        const inner = radius >> 1 < floor ? floor : radius >> 1
        const outer = radius + (radius >> 1) > maxRadius ? maxRadius : radius + (radius >> 1)
        let total = 0
        let levels = 0
        let overTotal = 0
        for (const rad of [inner, radius, outer]) {
          const m = windowMean(sums, seenCells, r, c, rad, from, to)
          if (Number.isNaN(m)) continue
          total += m
          levels++
          if (overSums !== null) {
            overTotal += windowMean(overSums, seenCells, r, c, rad, from, to)
          }
        }

        out[base + c] = levels > 0 ? total / levels : centre
        if (outOver !== null) {
          outOver[base + c] = levels > 0 ? overTotal / levels : (over?.[base + c] ?? Number.NaN)
        }
      }
    }
  }

  return { values: out, over: outOver, applied: smoothing, scope: null }
}
