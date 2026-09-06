/**
 * Serpentine binning: regions grown until each holds enough evidence to average.
 *
 * `render/smooth.ts` takes serpentine's *criterion* — hold the counts constant
 * instead of the window — and keeps a kernel's locality, so every cell gets its
 * own overlapping window and the picture is stable under panning. This file is
 * the other half: serpentine's own answer, a **partition**. Every pixel starts as
 * its own region; a region under the threshold absorbs a neighbour; passes repeat
 * until nothing moves; every cell then takes its region's mean.
 *
 * Three things a partition can do that a box window cannot, and they are the
 * reasons this exists beside the filter rather than instead of it:
 *
 * 1. **Regions are not square.** They grow along whatever direction carries
 *    signal, so a stripe or the edge of a domain is followed rather than blurred
 *    across. A box centred on a stripe averages the stripe with the empty space
 *    either side of it; a region grown along one does not.
 * 2. **The count target is met exactly, with no cap.** `smooth.ts` stops at a
 *    radius of 64 and a cell that has not reached its target by then stays noisy.
 *    A region keeps growing until it has what it needs.
 * 3. **It is the published method.** Baudry *et al.*,
 *    [*Bioinformatics* 2020](https://doi.org/10.1093/bioinformatics/btaa249),
 *    which is what a reviewer will recognise in a figure legend.
 *
 * ## Two matrices, and what the second one is here
 *
 * Serpentine is a differential method: it grows regions on **two** maps at once,
 * merging while *both* are short of the threshold, and reports `log2(B/A)`. There
 * is no single-matrix path in the reference implementation despite its README
 * mentioning one.
 *
 * Both shapes are available here, and the second is the interesting one:
 *
 * - **One field.** The criterion degenerates to `sum < threshold` and the result
 *   is an adaptively binned map. Honest, and mostly a denoised picture of the
 *   distance decay, which is the thing everybody already knows.
 * - **A field and a baseline.** Pass the expected map as the second field and the
 *   ratio of the two region means is an **O/E computed on serpentine regions** —
 *   numerator and denominator averaged over exactly the same cells. That is not a
 *   trick played on the algorithm; it is the arithmetic serpentine already does,
 *   handed a denominator it can derive from the map itself. It is also the same
 *   matched-window property `render/derive.ts` needs for the ordinary despeckle,
 *   for the same reason: divide a binned map by an unbinned curve and the steep
 *   near-diagonal decay reads as an enrichment the file never contained.
 *
 * Two consequences of the baseline being an *estimate of the map* rather than a
 * second experiment, both benign and both worth writing down. Depths match by
 * construction, so none of serpentine's trend-finding (`MDbefore`) is wanted —
 * the two fields already sum to the same thing. And `minthreshold`, which exists
 * to catch a coverage hole present in one experiment and not the other, has
 * nothing to catch: the expected is smooth and is never locally empty. The
 * criterion reduces to a threshold on the counts with a noise-free tie-breaker,
 * which is a *better* behaved thing than the two-experiment case rather than a
 * degenerate one — region growth stops depending on which cells happened to
 * catch a read.
 *
 * ## Why the merge order is offered twice
 *
 * The reference picks a **random** neighbour, which is what forces the ten
 * iterations: one random partition is arbitrary, and averaging many washes the
 * arbitrariness out. Faithful, and it is `sampled` below.
 *
 * It is also the thing that makes serpentine awkward in a viewer. The partition
 * is global and stochastic, so panning by one bin redraws every boundary and the
 * map reshuffles under the reader — and ten partitions cost ten times one.
 *
 * So `evidence` is offered beside it: absorb the neighbour holding the **most**
 * signal, neediest region first. It is deterministic, so it needs one pass rather
 * than ten and gives the same picture twice; and the rule is not merely a
 * convenient one, it is the greedy choice that reaches the target in the fewest
 * cells, which is the smallest region that can carry an estimate. It follows a
 * stripe for the same reason — that is where the counts are.
 *
 * What it gives up is the reference's own answer. `sampled` remains for a figure
 * that has to say "serpentine binning" and mean the published algorithm.
 */

/** Shape and values; structurally `render/derive.ts`'s `BlockValues`. */
interface Cells {
  nrows: number
  ncols: number
  values: Float32Array
  rowExtent: readonly [number, number]
  colExtent: readonly [number, number]
}

/** How a region picks which of its neighbours to absorb. */
export type MergeRule = 'evidence' | 'sampled'

/** What a caller asks the binning for. */
export interface SerpentineSpec {
  /**
   * Evidence each region must gather, in multiples of the block's mean cell.
   *
   * A multiple rather than an absolute count for the reason `smooth.ts` states:
   * `score` may have put balanced values in these cells, and a criterion in
   * counts would be met by one cell on a raw map and by no region at all on a
   * balanced one. It reduces to serpentine's own threshold when the cells are
   * counts.
   */
  target: number
  merge: MergeRule
  /** Partitions to average. Ignored by `evidence`, which has only one. */
  iterations: number
  /** Seed for `sampled`, so a figure comes out the same twice (§18.4). */
  seed: number
  /** What the caption calls it. */
  name: string
}

/**
 * The largest block this will run on, in cells.
 *
 * 4 M cells is a 2,000-bin square, which is what a whole chromosome wants: a
 * yeast chromosome at 1 kb is up to 1,531 bins and a 100 Mb human window at
 * 50 kb is 2,000, and the previous 1.5 M cap refused both — it fitted the
 * *small* yeast chromosomes at 1 kb and not the large ones, which is the worst
 * place for a limit to fall.
 *
 * It costs **7.3 s at the cap**, measured, against 1.2 s at 1.44 M. That is
 * superlinear — roughly `n^1.7` — because the adjacency starts as one typed
 * array per cell and two million of those is more garbage collection than
 * merging. It is the obvious thing to fix if this cap ever wants to go higher.
 *
 * This runs on the analysis thread (§18.3), so the cap is about **the wait**
 * rather than about a blocked frame — the same thing the correlation's own cap
 * measures, and the reason both are stated in seconds rather than in cells. The
 * map is drawn unbinned meanwhile and the job is cancellable, so the wait is
 * visible and escapable rather than a freeze.
 */
export const MAX_SERPENTINE_CELLS = 4_000_000

/**
 * The same, for the reference's random merge — a third of it.
 *
 * Held level with it deliberately, and the number to know before choosing this
 * setting is that **it is not the same wait**. `sampled` has no compaction to
 * lean on while it is picking uniformly and it coalesces much further, so it
 * does more merges into much larger regions: **12.3 s per partition at the cap**
 * against 7.3 s for the whole of `evidence`, and it averages three of them —
 * about **37 s** on a 2,000-bin square, against 1.4 s per partition at 841².
 *
 * It is offered at the full range anyway rather than being quietly narrowed,
 * because it is the published algorithm and a figure that has to say "serpentine
 * binning" and mean it should not be refused at the size a chromosome actually
 * is. The job runs on the analysis thread, reports the region count as it falls
 * and is cancellable, and the map is drawn unbinned throughout — so the cost is
 * a visible wait a reader can walk away from, not a frozen window. The
 * deterministic rule is right beside it at a fifth of the price.
 */
export const MAX_SAMPLED_CELLS = 4_000_000

/** mulberry32, as `analysis/random.ts` uses and for its reasons (§18.4). */
function seeded(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * One partition, grown to exhaustion.
 *
 * Union-find over the cells with the adjacency carried as a plain list per
 * region, compacted the first time anything reads it. The reference keeps a
 * `set` per region and calls `random.choice(tuple(set))`, which copies the whole
 * set to pick one element out of it — that single line is most of why serpentine
 * is measured in minutes, and dropping it took a faithful port of the merge loop
 * from 42 s to 7 s at 841².
 *
 * `roots` holds the region id of every cell at the end; the caller reads sums out
 * of it rather than being handed a partition object, because averaging several
 * partitions is the only thing anyone does with one.
 */
async function partition(
  domain: Int32Array,
  neighbours: (id: number, out: Int32Array) => number,
  criterion: Float64Array,
  /** The second map's cells, when there is one; `null` for a single-map run. */
  criterionB: Float64Array | null,
  threshold: number,
  minThreshold: number,
  rule: MergeRule,
  random: () => number,
  n: number,
  /**
   * Called before each pass, so a caller on a worker can report where it is and
   * a cancel can actually land.
   *
   * Between passes rather than inside one, and that is as fine-grained as this
   * loop can honestly be: a pass is one sweep over the live regions and there is
   * no consistent state to stop at halfway through a merge. A pass is tens of
   * milliseconds, which is the granularity a reader experiences as "it stopped
   * when I asked" — the same trade `analysis.worker.ts` makes every 64 rows of a
   * correlation.
   */
  breathe?: (pass: number, live: number) => Promise<void>,
): Promise<{ parent: Int32Array; sums: Float64Array; live: number }> {
  const parent = new Int32Array(n).fill(-1)
  const sums = new Float64Array(n)
  const sumsB = criterionB === null ? null : new Float64Array(n)
  const alive = new Uint8Array(n)
  const adj: Array<Int32Array | null> = new Array(n).fill(null)
  const alen = new Int32Array(n)
  const scratch = new Int32Array(8)

  for (const id of domain) {
    parent[id] = id
    sums[id] = criterion[id]
    if (sumsB !== null && criterionB !== null) sumsB[id] = criterionB[id]
    alive[id] = 1
    const count = neighbours(id, scratch)
    const list = new Int32Array(count)
    for (let k = 0; k < count; k++) list[k] = scratch[k]
    adj[id] = list
    alen[id] = count
  }

  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) {
      const next = parent[x]
      parent[x] = r
      x = next
    }
    return r
  }

  // Marks a root as already seen while one adjacency list is being compacted, so
  // the list collapses to distinct live neighbours instead of growing a copy of
  // every boundary cell the region has ever had.
  const stamp = new Int32Array(n).fill(-1)
  let epoch = 0

  /** Drop dead and duplicate entries, resolve the rest, and return the count. */
  const compact = (root: number): number => {
    const list = adj[root]
    if (list === null) return 0
    const mark = epoch++
    let write = 0
    for (let k = 0; k < alen[root]; k++) {
      const other = find(list[k])
      if (other === root || alive[other] === 0) continue
      if (stamp[other] === mark) continue
      stamp[other] = mark
      list[write++] = other
    }
    alen[root] = write
    return write
  }

  /**
   * Union the two regions and return the root that survived.
   *
   * **The longer adjacency list is the one that survives**, whichever region was
   * doing the asking. Appending a huge list to a small one copies the huge one
   * on every merge, and since a region absorbs hundreds of thousands of
   * neighbours on the way to its final size that is quadratic — it was most of
   * the running time. Which root survives is arbitrary: identity here is a
   * union-find root and nothing outside this function reads it.
   */
  const absorb = (asking: number, other: number): number => {
    const keep = alen[other] > alen[asking] ? other : asking
    const gone = keep === asking ? other : asking
    const a = adj[keep]
    const b = adj[gone]
    if (a === null || b === null) return keep
    const need = alen[keep] + alen[gone]
    let list = a
    if (need > a.length) {
      list = new Int32Array(Math.max(need, a.length * 2))
      list.set(a.subarray(0, alen[keep]))
      adj[keep] = list
    }
    list.set(b.subarray(0, alen[gone]), alen[keep])
    alen[keep] = need
    adj[gone] = null
    sums[keep] += sums[gone]
    if (sumsB !== null) sumsB[keep] += sumsB[gone]
    parent[gone] = keep
    alive[gone] = 0
    return keep
  }

  let order = Int32Array.from(domain)
  let count = order.length
  let live = count
  let previous = -1

  // Coarse "neediest first", as a counting sort into 32 buckets of how far a
  // region still is from the threshold. A plain scan order lets regions drift in
  // the direction the loop happens to run; a full sort per pass costs more than
  // the merging does. This is neither.
  const BUCKETS = 32
  const tally = new Int32Array(BUCKETS + 1)
  const staged = new Int32Array(count)
  const bucketOf = (sum: number): number => {
    const share = sum / threshold
    const at = Math.floor(share * BUCKETS)
    return at < 0 ? 0 : at >= BUCKETS ? BUCKETS - 1 : at
  }

  let passes = 0
  while (live !== previous) {
    previous = live
    if (breathe !== undefined) await breathe(passes, live)
    passes++
    // Live regions only. After a couple of passes this is a small fraction of
    // the block and sweeping every original slot is most of the work.
    let write = 0
    for (let k = 0; k < count; k++) {
      const id = order[k]
      if (alive[id] === 1) order[write++] = id
    }
    count = write

    if (rule === 'sampled') {
      for (let k = count - 1; k > 0; k--) {
        const j = (random() * (k + 1)) | 0
        const t = order[k]
        order[k] = order[j]
        order[j] = t
      }
    } else {
      tally.fill(0)
      for (let k = 0; k < count; k++) tally[bucketOf(sums[order[k]]) + 1]++
      for (let b = 0; b < BUCKETS; b++) tally[b + 1] += tally[b]
      for (let k = 0; k < count; k++) staged[tally[bucketOf(sums[order[k]])]++] = order[k]
      for (let k = 0; k < count; k++) order[k] = staged[k]
    }

    for (let k = 0; k < count; k++) {
      const region = order[k]
      if (alive[region] === 0) continue
      // The reference's own test, with both maps in it: keep merging while
      // *both* are short of the threshold, or while *either* is under the
      // minimum. With one map it collapses to `sum < threshold`.
      const sum = sums[region]
      const sumB = sumsB === null ? sum : sumsB[region]
      const short = sum < threshold && sumB < threshold
      const starved = sum < minThreshold || sumB < minThreshold
      if (!short && !starved) continue

      let chosen = -1
      if (rule === 'sampled') {
        // Sampled without compacting first: a random index, and a stale entry is
        // swapped off the end and retried. Compaction here would put the
        // reference's own `tuple(set)` back — a pass over the whole list to pick
        // one element out of it.
        // Compacted once the list has grown past a boundary any real region
        // has, which bounds the stale entries a big region accumulates and, as
        // it happens, makes the sampling *more* faithful: the reference draws
        // uniformly from a `set` of distinct neighbours, and an uncompacted list
        // would weight them by how much boundary each one shares.
        if (alen[region] > 32) compact(region)
        const list = adj[region]
        if (list === null) continue
        let length = alen[region]
        while (length > 0) {
          const at = (random() * length) | 0
          const other = find(list[at])
          if (other === region || alive[other] === 0) {
            list[at] = list[length - 1]
            length--
            continue
          }
          chosen = other
          break
        }
        alen[region] = length
      } else {
        // Always compacted, unlike the sampled branch above: this scan reads
        // `sums[other]` and merges the winner, so it needs resolved live roots.
        // An unresolved cell id is a dead region's stale sum, and merging into a
        // dead region does not reduce the live count — the outer loop then never
        // converges, which is exactly what it did.
        const total = compact(region)
        if (total === 0) continue
        const list = adj[region]
        if (list === null) continue
        // **Among the neighbours that are themselves still short.** Absorbing the
        // richest neighbour outright is the obvious greedy rule and it is a trap:
        // the richest neighbour is almost always one that has *already* met the
        // threshold, so every needy region eats a satisfied one, the result is
        // needy again, and the whole block cascades into a single region — which
        // is exactly what it did. Randomness hides this in the reference, because
        // a random neighbour is usually another needy one.
        //
        // Restricted to the needy, the rule is sound and keeps what it was for:
        // the most evidence reaches the target in the fewest cells, which is the
        // smallest region that can carry an estimate, and it is the direction a
        // stripe runs in. A region with no needy neighbour left has nothing to
        // pair with and stops.
        let best = -1
        // The fallback, tracked in the same pass: the *smallest* neighbour of
        // any kind. A needy region ringed entirely by satisfied ones would
        // otherwise have nobody to pair with and would sit below the threshold
        // for good — stranded and noisy, which at a low target is most of what
        // went wrong out where the data is thinnest. Merging it into the
        // smallest neighbour cannot cascade: it is the opposite of the choice
        // that did, it happens only when the needy set is empty, and the result
        // clears the threshold and stops.
        let spare = -1
        let smallest = 0
        for (let k2 = 0; k2 < total; k2++) {
          const other = list[k2]
          const value = sums[other]
          const otherB = sumsB === null ? value : sumsB[other]
          if (spare === -1 || value < smallest || (value === smallest && other < spare)) {
            smallest = value
            spare = other
          }
          if (!(value < threshold && otherB < threshold)) continue
          if (chosen === -1 || value > best || (value === best && other < chosen)) {
            best = value
            chosen = other
          }
        }
        if (chosen === -1) chosen = spare
      }
      if (chosen === -1) continue
      absorb(region, chosen)
      live--
    }
  }

  for (const id of domain) find(id)
  return { parent, sums, live }
}

/**
 * Bin a block into serpentine regions and return each cell's region mean.
 *
 * `counts` is the block as read — what the threshold is measured against and
 * what the criterion is tested on — while `block.values` is what gets averaged,
 * which is whatever the derivation has made of it by now. `over` is the optional
 * second field: pass the expected map and the caller can divide one result by the
 * other for an O/E computed on regions, numerator and denominator averaged over
 * exactly the same cells.
 *
 * A **square block on the diagonal is binned on one triangle and mirrored**. The
 * matrix is symmetric, so growing regions over the whole square would grow two
 * independent partitions of the same data and draw a map that disagreed with its
 * own transpose — visible as an asymmetric picture of a symmetric measurement.
 * Off-diagonal and rectangular blocks have no such constraint and are binned
 * whole.
 */
export async function serpentineBin(
  block: Cells,
  counts: Float32Array,
  spec: SerpentineSpec,
  over?: Float32Array,
  breathe?: (pass: number, live: number) => Promise<void>,
): Promise<{
  values: Float32Array
  over: Float32Array | null
  regions: number
  scope: string | null
}> {
  const { nrows, ncols, values } = block
  const n = nrows * ncols
  if (nrows === 0 || ncols === 0) return { values, over: over ?? null, regions: 0, scope: null }
  if (n > MAX_SERPENTINE_CELLS) {
    return { values, over: over ?? null, regions: 0, scope: 'serpentine not applied — block too large' }
  }

  // What the target is a multiple of, measured on the counts and over the cells
  // that hold something. Same convention as `render/smooth.ts`, and for the same
  // reason: these are not always counts.
  let total = 0
  let seen = 0
  for (let i = 0; i < n; i++) {
    const v = counts[i]
    if (Number.isFinite(v) && v > 0) {
      total += v
      seen++
    }
  }
  const scale = seen > 0 ? total / seen : 0
  if (!(scale > 0)) return { values, over: over ?? null, regions: 0, scope: null }
  const threshold = spec.target * scale
  // The reference's own ratio between the two: `minthreshold` defaults to a
  // fifth of `threshold`, and the CLI derives it that way when it is left auto.
  const minThreshold = threshold / 5

  const symmetric =
    nrows === ncols &&
    block.rowExtent[0] === block.colExtent[0] &&
    block.rowExtent[1] === block.colExtent[1]

  const domainList: number[] = []
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < ncols; c++) {
      if (symmetric && r < c) continue
      domainList.push(r * ncols + c)
    }
  }
  const domain = Int32Array.from(domainList)

  const neighbours = (id: number, out: Int32Array): number => {
    const r = (id / ncols) | 0
    const c = id - r * ncols
    let k = 0
    if (r > 0 && !(symmetric && r - 1 < c)) out[k++] = id - ncols
    if (r < nrows - 1) out[k++] = id + ncols
    if (c > 0) out[k++] = id - 1
    if (c < ncols - 1 && !(symmetric && r < c + 1)) out[k++] = id + 1
    return k
  }

  const usable = (i: number): boolean =>
    Number.isFinite(values[i]) && (over === undefined || Number.isFinite(over[i]))

  const critA = new Float64Array(n)
  const critB = over === undefined ? null : new Float64Array(n)
  for (const id of domain) {
    const v = counts[id]
    critA[id] = Number.isFinite(v) && v > 0 ? v : 0
    if (critB !== null && over !== undefined) {
      const w = over[id]
      critB[id] = Number.isFinite(w) && w > 0 ? w : 0
    }
  }

  const runs = spec.merge === 'sampled' ? Math.max(1, Math.floor(spec.iterations)) : 1
  const random = seeded(spec.seed)
  const accV = new Float64Array(n)
  const accO = over === undefined ? null : new Float64Array(n)
  const sumV = new Float64Array(n)
  const sumO = over === undefined ? null : new Float64Array(n)
  const fin = new Int32Array(n)
  // Whether a cell's region ever held anything finite. A region of nothing but
  // discarded bins has no mean, and `accV` would read as a confident zero.
  const covered = new Uint8Array(n)
  let regions = 0

  for (let pass = 0; pass < runs; pass++) {
    const { parent, live } = await partition(
      domain,
      neighbours,
      critA,
      critB,
      threshold,
      minThreshold,
      spec.merge,
      random,
      n,
      breathe,
    )
    regions = live

    sumV.fill(0)
    sumO?.fill(0)
    fin.fill(0)
    for (const id of domain) {
      if (!usable(id)) continue
      const root = parent[id]
      sumV[root] += values[id]
      fin[root]++
      if (sumO !== null && over !== undefined) sumO[root] += over[id]
    }
    for (const id of domain) {
      const root = parent[id]
      const count = fin[root]
      if (count === 0) continue
      accV[id] += sumV[root] / count
      covered[id] = 1
      if (accO !== null && sumO !== null) accO[id] += sumO[root] / count
    }
  }

  const outValues = new Float32Array(n)
  const outOver = accO === null ? null : new Float32Array(n)
  for (const id of domain) {
    // A cell with nothing in it keeps nothing, exactly as the despeckle leaves a
    // hole alone: a region mean is not a report about a bin the balancer threw
    // away, and neither is one about a region that held only such bins.
    const blank = Number.isNaN(values[id]) || covered[id] === 0
    outValues[id] = blank ? Number.NaN : accV[id] / runs
    if (outOver !== null && accO !== null) outOver[id] = blank ? Number.NaN : accO[id] / runs
    if (!symmetric) continue
    const r = (id / ncols) | 0
    const c = id - r * ncols
    if (r === c) continue
    const mirror = c * ncols + r
    outValues[mirror] = outValues[id]
    if (outOver !== null) outOver[mirror] = outOver[id]
  }

  return { values: outValues, over: outOver, regions, scope: null }
}
