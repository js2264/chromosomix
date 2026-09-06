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
 * **Where it sits matters more than the kernel does.** This is applied per file,
 * before two files are combined (`render/derive.ts`, `ui/MatrixPanel.ts`), so a
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

/**
 * How much smoothing a reader asked for.
 *
 * Three shapes of one idea, in order of how far they go: a fixed window, a
 * window that sizes itself, and a partition grown until each region has what it
 * needs (`render/serpentine.ts`). The first two are kernels and stay local; the
 * third is serpentine's own answer and is not.
 */
export type Smoothing =
  | { kind: 'fixed'; radius: number }
  | {
      kind: 'serpentine'
      /** Evidence a region must gather, in multiples of the block's mean cell. */
      target: number
      /** `evidence` is deterministic; `sampled` is the reference's random merge. */
      merge: 'evidence' | 'sampled'
      /** Partitions to average. Only `sampled` has more than one. */
      iterations: number
      /** Seed for `sampled`, so a figure comes out the same twice (§18.4). */
      seed: number
      /** The despeckle radius to fall back to where the binning is refused. */
      floor: number
      name: string
    }
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
       * the target inside 3 × 3 and is left almost unsmoothed, so the three
       * adaptive settings would look identical along the diagonal and differ
       * only far from it. With one, each adaptive setting *starts* at its fixed
       * counterpart and grows from there, which is the relationship the picker
       * puts in front of the reader: `light` is 3 × 3 or wider, never narrower.
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
 * It was 64, and 64 was too low to tell the three settings apart where it
 * mattered most. On a yeast map at 500 bp every one of them ran into the cap
 * beyond about 200 bins of separation, so `light`, `medium` and `strong` drew the
 * same picture out there and differed only nearer the diagonal — the cap, not the
 * target, was choosing the width for the cells with the least data. At 192 the
 * target is what decides, which is the whole point of the setting.
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
 * The summed-area tables below are the size of the block and `Float64` — three
 * of them, or four when a baseline is being averaged alongside the map for an
 * O/E. That is about **128 MB at this cap**, allocated and freed inside one
 * derivation, for **300 ms** of work on a 2,000-bin square. Both numbers are
 * measured. At the 4096² raster cap the tables would be over half a gigabyte,
 * which is not a trade-off worth making silently for a whole-genome view whose
 * cells are pooled from thousands of contacts each and are not short of evidence
 * in the first place.
 *
 * Raised from 2 M alongside `render/serpentine.ts`'s own cap, and for its
 * reason: a whole chromosome is a 1,200- to 2,000-bin square, and a limit that
 * fitted the small yeast chromosomes at 1 kb while refusing the large ones fell
 * in the worst possible place. Unlike the binning, this runs *here*, on the
 * thread drawing frames — 300 ms is a hitch on a dropdown, which is why the
 * ceiling is the memory rather than the wait.
 *
 * Above it the picker's choice is honoured at its {@link Smoothing.floor} and
 * the caption says so, which is the same refusal the correlation makes: a real
 * picture, and a caption that does not claim to be the one that was asked for.
 */
export const MAX_ADAPTIVE_CELLS = 4_000_000

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
 * Three adaptive settings rather than a number box because the target is not a
 * quantity a reader has any way to choose. What they can judge is the picture,
 * and the ladder is arranged so that each adaptive setting behaves like the
 * fixed one above it where the data is rich and widens where it is not: on a
 * yeast map at 500 bp, `light` runs 3 × 3 along the diagonal and 21 × 21 at
 * 200 bins out, `strong` runs 7 × 7 and 81 × 81.
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
    label: 'adaptive · light',
    smoothing: { kind: 'adaptive', target: 50, floor: 1, name: 'light' },
  },
  {
    id: 'a200',
    label: 'adaptive · medium',
    smoothing: { kind: 'adaptive', target: 200, floor: 2, name: 'medium' },
  },
  {
    id: 'a800',
    label: 'adaptive · strong',
    smoothing: { kind: 'adaptive', target: 800, floor: 3, name: 'strong' },
  },
  // The serpentine targets are an order of magnitude below the adaptive ones and
  // that is not an inconsistency: a *region* keeps growing until it reaches its
  // target with no cap, while a window stops at 64 and often falls short, so the
  // same number would mean a far coarser picture here. `medium` is set at the
  // reference's own default — 50 counts, on a map whose mean occupied cell is
  // about one.
  {
    id: 's20',
    label: 'serpentine · light',
    smoothing: {
      kind: 'serpentine',
      target: 20,
      merge: 'evidence',
      iterations: 1,
      seed: 1,
      floor: 1,
      name: 'light',
    },
  },
  {
    id: 's50',
    label: 'serpentine · medium',
    smoothing: {
      kind: 'serpentine',
      target: 50,
      merge: 'evidence',
      iterations: 1,
      seed: 1,
      floor: 2,
      name: 'medium',
    },
  },
  {
    id: 's120',
    label: 'serpentine · strong',
    smoothing: {
      kind: 'serpentine',
      target: 120,
      merge: 'evidence',
      iterations: 1,
      seed: 1,
      floor: 3,
      name: 'strong',
    },
  },
  {
    id: 'sx20',
    label: 'serpentine · light (sampled)',
    smoothing: {
      kind: 'serpentine',
      target: 20,
      merge: 'sampled',
      iterations: 3,
      seed: 1,
      floor: 1,
      name: 'light, sampled',
    },
  },
  {
    id: 'sx50',
    label: 'serpentine · medium (sampled)',
    smoothing: {
      kind: 'serpentine',
      target: 50,
      merge: 'sampled',
      iterations: 3,
      seed: 1,
      floor: 2,
      name: 'medium, sampled',
    },
  },
  {
    id: 'sx120',
    label: 'serpentine · strong (sampled)',
    smoothing: {
      kind: 'serpentine',
      target: 120,
      merge: 'sampled',
      iterations: 3,
      seed: 1,
      floor: 3,
      name: 'strong, sampled',
    },
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
    offered.kind === smoothing.kind &&
    (smoothing.kind === 'fixed'
      ? offered.kind === 'fixed' && offered.radius === smoothing.radius
      : offered.kind !== 'fixed' && offered.name === smoothing.name)
  return SMOOTH_CHOICES.find((choice) => choice.smoothing !== null && same(choice.smoothing))?.id ?? '0'
}

/**
 * What the colourbar caption calls a setting.
 *
 * The adaptive settings say `adaptively` rather than a window size because there
 * is no one window to name — the point of the setting is that the number varies
 * across the picture — and a caption naming the widest or the commonest of them
 * would be the one part of the figure that survives an export saying something
 * that is not true of most of it.
 */
export function smoothingCaption(smoothing: Smoothing): string {
  if (smoothing.kind === 'fixed') return smoothLabel(smoothing.radius)
  if (smoothing.kind === 'serpentine') return `into serpentine regions (${smoothing.name})`
  return `adaptively (${smoothing.name})`
}

/** A cumulative table and the row stride its box queries need. */
interface Summed {
  table: Float64Array
  /** `ncols + 1`. */
  stride: number
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
  nrows: number,
  ncols: number,
  contribution: (index: number) => number,
): Summed {
  const stride = ncols + 1
  const table = new Float64Array((nrows + 1) * stride)
  for (let r = 0; r < nrows; r++) {
    const above = r * stride
    const here = (r + 1) * stride
    const base = r * ncols
    let running = 0
    for (let c = 0; c < ncols; c++) {
      running += contribution(base + c)
      table[here + c + 1] = table[above + c + 1] + running
    }
  }
  return { table, stride }
}

/** The sum over rows `r0..r1` and columns `c0..c1`, both inclusive. */
function box(s: Summed, r0: number, c0: number, r1: number, c1: number): number {
  const { table, stride } = s
  const top = r0 * stride
  const bottom = (r1 + 1) * stride
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

  const evidence = summed(nrows, ncols, (i) => {
    const v = counts[i]
    return Number.isFinite(v) && v > 0 ? v : 0
  })
  // One mask for every table below, and it has to be one: the bias only cancels
  // out of the ratio if the two fields were averaged over exactly the same cells
  // with exactly the same divisor. A cell missing from either field is missing
  // from both.
  const usable = (i: number): boolean =>
    Number.isFinite(values[i]) && (over === undefined || Number.isFinite(over[i]))
  const sums = summed(nrows, ncols, (i) => (usable(i) ? values[i] : 0))
  const overSums =
    over === undefined ? null : summed(nrows, ncols, (i) => (usable(i) ? over[i] : 0))
  const seenCells = summed(nrows, ncols, (i) => (usable(i) ? 1 : 0))

  const out = new Float32Array(nrows * ncols)
  const outOver = overSums === null ? null : new Float32Array(nrows * ncols)
  for (let r = 0; r < nrows; r++) {
    const base = r * ncols
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
      let lo = floor
      let hi = maxRadius
      let radius = maxRadius
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const r0 = r - mid < 0 ? 0 : r - mid
        const c0 = c - mid < 0 ? 0 : c - mid
        const r1 = r + mid >= nrows ? nrows - 1 : r + mid
        const c1 = c + mid >= ncols ? ncols - 1 : c + mid
        if (box(evidence, r0, c0, r1, c1) >= threshold) {
          radius = mid
          hi = mid - 1
        } else {
          lo = mid + 1
        }
      }

      const r0 = r - radius < 0 ? 0 : r - radius
      const c0 = c - radius < 0 ? 0 : c - radius
      const r1 = r + radius >= nrows ? nrows - 1 : r + radius
      const c1 = c + radius >= ncols ? ncols - 1 : c + radius
      const sum = box(sums, r0, c0, r1, c1)
      const count = box(seenCells, r0, c0, r1, c1)

      out[base + c] = count > 0 ? sum / count : centre
      if (outOver !== null && overSums !== null) {
        const overSum = box(overSums, r0, c0, r1, c1)
        outOver[base + c] = count > 0 ? overSum / count : (over?.[base + c] ?? Number.NaN)
      }
    }
  }

  return { values: out, over: outOver, applied: smoothing, scope: null }
}
