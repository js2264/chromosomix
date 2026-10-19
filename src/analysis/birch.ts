/**
 * BIRCH, as `cooltools.dots` groups its enriched pixels with it (§18.8).
 *
 * `clust_2D_pixels` hands scikit-learn's `Birch(n_clusters=None, threshold=r)`
 * the enriched pixels of one chromosome, each as its two start coordinates in
 * base pairs, in the order `dots` sorted them; a pixel's cluster is its
 * `labels_`, the subcluster whose centroid is nearest to it; and the call
 * `dots` reports for a cluster is its brightest pixel. So the clustering decides
 * which pixel of a smear is the loop, and how many pixels the cluster had —
 * which is what the HiCCUPS filter lets a lone pixel through on or not.
 *
 * ## The upstream, exactly
 *
 * scikit-learn 1.9.1's `_birch.py`: a CF-tree of at most fifty subclusters a
 * node, each sample sent down it to the nearest subcluster at every level and
 * merged at the leaf when the merged radius stays within `r`, a full node split
 * between its two farthest subclusters, and the labels assigned afterwards by
 * nearest centroid (`pairwise_distances_argmin`). It is order-dependent by
 * design — a sample that arrives first founds the subcluster the next one
 * joins — so the samples are taken in `dots`' own order and nothing is sorted.
 *
 * **And its floating point, exactly**, because ties are the ordinary case here
 * rather than the exception: pixels sit on a grid of the bin size, so two
 * pixels four bins apart are *exactly* twice a 2-bin radius apart, and whether
 * they merge is decided by how `Σ‖x‖²/n − ‖c‖²` rounds. NumPy computes every
 * dot product of two coordinates through OpenBLAS, which **fuses** a multiply
 * into the add on any x86-64 or ARM machine of the last decade, and not always
 * the same one: `ddot` and `dgemm` fuse the second product (`fma(a₁, b₁, a₀b₀)`)
 * and `dgemv` the first (`fma(a₀, b₀, a₁b₁)`), while `einsum`'s row norms fuse
 * nothing. Each call site below rounds as its counterpart does, through an
 * exactly rounded {@link fma} — measured against NumPy 2.5.4's bundled OpenBLAS
 * 0.3.34 on every node size a split can see and on the Fortran-ordered array
 * `dots` hands sklearn, and held to scikit-learn's own labels by
 * `test/unit/analysis-hiccups.test.ts`. A machine whose BLAS rounds otherwise
 * clusters a tie otherwise, in cooltools itself; that is a property of the
 * reference, and the one place its answer depends on the machine.
 */

/** sklearn's `Birch(branching_factor=50)` default, which `dots` keeps. */
export const BIRCH_BRANCHING = 50

/** One clustering: a label per sample, and the subclusters' centroids. */
export interface BirchResult {
  /** Per sample: the index of the nearest subcluster centroid in {@link centers}. */
  labels: Int32Array
  /** `subcluster_centers_`, two numbers a subcluster, in leaf order. */
  centers: Float64Array
}

// ---------------------------------------------------------------------------
// An exactly rounded fused multiply-add
// ---------------------------------------------------------------------------

const BITS = new Float64Array(1)
const WORDS = new Uint32Array(BITS.buffer)
/** The low word of a double is `WORDS[0]` on a little-endian platform, which every JS engine is. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1
/** Veltkamp's constant for a 53-bit significand: `2^27 + 1`. */
const SPLITTER = 134217729

/** The double after `x` away from zero (`away`) or toward it. */
function nextDouble(x: number, away: boolean): number {
  BITS[0] = x
  const lo = LITTLE_ENDIAN ? 0 : 1
  const hi = 1 - lo
  if (away) {
    WORDS[lo] = (WORDS[lo] + 1) >>> 0
    if (WORDS[lo] === 0) WORDS[hi] = (WORDS[hi] + 1) >>> 0
  } else {
    if (WORDS[lo] === 0) WORDS[hi] = (WORDS[hi] - 1) >>> 0
    WORDS[lo] = (WORDS[lo] - 1) >>> 0
  }
  return BITS[0]
}

function odd(x: number): boolean {
  BITS[0] = x
  return (WORDS[LITTLE_ENDIAN ? 0 : 1] & 1) === 1
}

/**
 * `round(a·b + c)`, rounded once, as a hardware FMA rounds it.
 *
 * Boldo and Melquiond's algorithm (*Emulation of FMA and correctly rounded
 * sums: proved algorithms using rounding to odd*, IEEE Trans. Comput. 57:462,
 * 2008): the product split exactly into two doubles by Dekker's product, its
 * high half added to `c` exactly, the two low halves summed **rounded to odd**,
 * and the whole rounded to nearest once. Correct for every finite argument
 * whose product neither overflows nor underflows, which a coordinate in base
 * pairs never comes near.
 */
export function fma(a: number, b: number, c: number): number {
  const ph = a * b
  if (!Number.isFinite(ph) || !Number.isFinite(c)) return ph + c
  // Dekker's exact product: ph + pl = a·b.
  let t = SPLITTER * a
  const ah = t - (t - a)
  const al = a - ah
  t = SPLITTER * b
  const bh = t - (t - b)
  const bl = b - bh
  const pl = ah * bh - ph + ah * bl + al * bh + al * bl
  // Knuth's exact sum: th + tl = c + ph.
  const th = c + ph
  const bv = th - c
  const tl = c - (th - bv) + (ph - bv)
  // tl + pl, rounded to odd.
  let v = tl + pl
  const vb = v - tl
  const ve = tl - (v - vb) + (pl - vb)
  if (ve !== 0 && !odd(v)) v = nextDouble(v, ve > 0 === v > 0)
  return th + v
}

// ---------------------------------------------------------------------------
// The four ways NumPy rounds a dot product of two coordinates
// ---------------------------------------------------------------------------

/** `np.dot` of two vectors, and sklearn's `_dot`: BLAS `ddot`. */
function ddot(a0: number, a1: number, b0: number, b1: number): number {
  return fma(a1, b1, a0 * b0)
}

/** One row of `np.dot(matrix, vector)`: BLAS `dgemv`, or `ddot` for a single row. */
function gemvRow(a0: number, a1: number, b0: number, b1: number, rows: number): number {
  return rows === 1 ? fma(a1, b1, a0 * b0) : fma(a0, b0, a1 * b1)
}

/** One cell of `X @ Y.T`: BLAS `dgemm` (or `dsyrk`, which rounds alike). */
function gemm(a0: number, a1: number, b0: number, b1: number): number {
  return fma(a1, b1, a0 * b0)
}

/** `np.einsum('ij,ij->i', X, X)`, sklearn's `row_norms(squared=True)`: nothing fused. */
function rowNorm(a0: number, a1: number): number {
  return a0 * a0 + a1 * a1
}

// ---------------------------------------------------------------------------
// The CF-tree
// ---------------------------------------------------------------------------

/** `_CFSubcluster`: a running count, linear sum and squared sum, and a child node. */
class Subcluster {
  n = 0
  ls0 = 0
  ls1 = 0
  ss = 0
  c0 = 0
  c1 = 0
  sqNorm = 0
  child: Node | null = null

  static of(x0: number, x1: number): Subcluster {
    const sub = new Subcluster()
    sub.n = 1
    sub.ls0 = x0
    sub.ls1 = x1
    sub.c0 = x0
    sub.c1 = x1
    sub.ss = sub.sqNorm = ddot(x0, x1, x0, x1)
    return sub
  }

  update(other: Subcluster): void {
    this.n += other.n
    this.ls0 += other.ls0
    this.ls1 += other.ls1
    this.ss += other.ss
    this.c0 = this.ls0 / this.n
    this.c1 = this.ls1 / this.n
    this.sqNorm = ddot(this.c0, this.c1, this.c0, this.c1)
  }

  /** `merge_subcluster`: take `nominee` in if the merged radius stays within `threshold`. */
  merge(nominee: Subcluster, threshold: number): boolean {
    const ss = this.ss + nominee.ss
    const ls0 = this.ls0 + nominee.ls0
    const ls1 = this.ls1 + nominee.ls1
    const n = this.n + nominee.n
    // `(1 / new_n) * new_ls`: a reciprocal and a product, which rounds apart
    // from a quotient.
    const inv = 1 / n
    const c0 = inv * ls0
    const c1 = inv * ls1
    const sqNorm = ddot(c0, c1, c0, c1)
    const sqRadius = ss / n - sqNorm
    if (sqRadius <= threshold * threshold) {
      this.n = n
      this.ls0 = ls0
      this.ls1 = ls1
      this.ss = ss
      this.c0 = c0
      this.c1 = c1
      this.sqNorm = sqNorm
      return true
    }
    return false
  }
}

/** `_CFNode`: up to `branching + 1` subclusters, and the leaf list's links. */
class Node {
  readonly subclusters: Subcluster[] = []
  /** `init_centroids_` and `init_sq_norm_`: copies, refreshed as `_CFNode` refreshes them. */
  readonly centroids: number[] = []
  readonly sqNorms: number[] = []
  prev: Node | null = null
  next: Node | null = null

  constructor(
    readonly threshold: number,
    readonly branching: number,
    readonly leaf: boolean,
  ) {}

  append(sub: Subcluster): void {
    const at = this.subclusters.length
    this.subclusters.push(sub)
    this.centroids[2 * at] = sub.c0
    this.centroids[2 * at + 1] = sub.c1
    this.sqNorms[at] = sub.sqNorm
  }

  private refresh(at: number): void {
    const sub = this.subclusters[at]
    this.centroids[2 * at] = sub.c0
    this.centroids[2 * at + 1] = sub.c1
    this.sqNorms[at] = sub.sqNorm
  }

  /** `update_split_subclusters`. */
  private replace(sub: Subcluster, first: Subcluster, second: Subcluster): void {
    const at = this.subclusters.indexOf(sub)
    this.subclusters[at] = first
    this.refresh(at)
    this.append(second)
  }

  /** `insert_cf_subcluster`: `true` when this node now needs splitting. */
  insert(sub: Subcluster): boolean {
    const rows = this.subclusters.length
    if (rows === 0) {
      this.append(sub)
      return false
    }
    // `np.dot(centroids_, c) * -2.0 + squared_norm_`, and its first minimum.
    let closest = 0
    let least = Number.POSITIVE_INFINITY
    for (let k = 0; k < rows; k++) {
      const d =
        gemvRow(this.centroids[2 * k], this.centroids[2 * k + 1], sub.c0, sub.c1, rows) * -2.0 +
        this.sqNorms[k]
      if (d < least) {
        least = d
        closest = k
      }
    }
    const near = this.subclusters[closest]
    if (near.child !== null) {
      const splitChild = near.child.insert(sub)
      if (!splitChild) {
        near.update(sub)
        this.refresh(closest)
        return false
      }
      const [first, second] = splitNode(near.child, this.threshold, this.branching)
      this.replace(near, first, second)
      return this.subclusters.length > this.branching
    }
    if (near.merge(sub, this.threshold)) {
      this.refresh(closest)
      return false
    }
    this.append(sub)
    return this.subclusters.length > this.branching
  }
}

/** `_split_node`: two new subclusters, each over the half nearer one of the farthest pair. */
function splitNode(node: Node, threshold: number, branching: number): [Subcluster, Subcluster] {
  const first = new Subcluster()
  const second = new Subcluster()
  const left = new Node(threshold, branching, node.leaf)
  const right = new Node(threshold, branching, node.leaf)
  first.child = left
  second.child = right
  if (node.leaf) {
    if (node.prev !== null) node.prev.next = left
    left.prev = node.prev
    left.next = right
    right.prev = left
    right.next = node.next
    if (node.next !== null) node.next.prev = right
  }

  // `euclidean_distances(centroids_, squared=True)` with Y the same array: the
  // norms are einsum's (the `Y_norm_squared` it is handed is not read when Y is
  // X), the cross term `-2 * X @ X.T`, both norms added in that order, floored
  // at zero, and the diagonal set to zero.
  const m = node.subclusters.length
  const c = node.centroids
  const norms = new Float64Array(m)
  for (let a = 0; a < m; a++) norms[a] = rowNorm(c[2 * a], c[2 * a + 1])
  const dist = new Float64Array(m * m)
  let farthest = 0
  for (let a = 0; a < m; a++) {
    for (let b = 0; b < m; b++) {
      let d = 0
      if (a !== b) {
        d = -2 * gemm(c[2 * a], c[2 * a + 1], c[2 * b], c[2 * b + 1]) + norms[a] + norms[b]
        if (!(d > 0)) d = 0
      }
      dist[a * m + b] = d
      if (d > dist[farthest]) farthest = a * m + b
    }
  }
  const i = Math.floor(farthest / m)
  const j = farthest % m
  for (let k = 0; k < m; k++) {
    const sub = node.subclusters[k]
    // `node1_dist < node2_dist`, with the first of the pair always on its own side.
    if (k === i || dist[i * m + k] < dist[j * m + k]) {
      left.append(sub)
      first.update(sub)
    } else {
      right.append(sub)
      second.update(sub)
    }
  }
  return [first, second]
}

/**
 * `Birch(threshold, branching_factor, n_clusters=None).fit(points)`, and its `labels_`.
 *
 * `points` is `n × 2`, row-major, in the order they are to be inserted.
 */
export function birch(points: Float64Array, threshold: number, branching = BIRCH_BRANCHING): BirchResult {
  const n = points.length / 2
  let root = new Node(threshold, branching, true)
  const dummy = new Node(threshold, branching, true)
  dummy.next = root
  root.prev = dummy
  for (let s = 0; s < n; s++) {
    const sub = Subcluster.of(points[2 * s], points[2 * s + 1])
    if (root.insert(sub)) {
      const [first, second] = splitNode(root, threshold, branching)
      root = new Node(threshold, branching, false)
      root.append(first)
      root.append(second)
    }
  }

  const centroids: number[] = []
  for (let leaf: Node | null = dummy.next; leaf !== null; leaf = leaf.next) {
    for (let k = 0; k < leaf.subclusters.length; k++) {
      centroids.push(leaf.centroids[2 * k], leaf.centroids[2 * k + 1])
    }
  }
  const centers = Float64Array.from(centroids)
  const m = centers.length / 2

  // `pairwise_distances_argmin(X, centers, Y_norm_squared=row_norms(centers))`.
  // `dots` builds X from a DataFrame's `.values`, which pandas hands back in
  // Fortran order, and sklearn's Cython reduction takes C-ordered arrays only —
  // so this is its fallback, `euclidean_distances` chunk by chunk and an
  // `argmin`: `−2 x·y` from `dgemm`, then einsum's `‖x‖²`, then the `‖y‖²`
  // handed in, floored at zero and **square-rooted**, which can round two
  // different squared distances to one. The first of equal distances wins.
  //
  // The fused distance is only needed where it could decide: a first pass with
  // plain products finds the nearest centroid to within far more than the two
  // roundings can part — 1e-12 of the magnitudes summed, against their 1e-15 —
  // and only the centroids that close are measured exactly, in order.
  const norms = new Float64Array(m)
  for (let k = 0; k < m; k++) norms[k] = rowNorm(centers[2 * k], centers[2 * k + 1])
  const plain = new Float64Array(m)
  const labels = new Int32Array(n)
  for (let s = 0; s < n; s++) {
    const x0 = points[2 * s]
    const x1 = points[2 * s + 1]
    const own = rowNorm(x0, x1)
    let nearest = Number.POSITIVE_INFINITY
    for (let k = 0; k < m; k++) {
      const d = -2 * (x0 * centers[2 * k] + x1 * centers[2 * k + 1]) + own + norms[k]
      plain[k] = d
      if (d < nearest) nearest = d
    }
    let best = 0
    let least = Number.POSITIVE_INFINITY
    for (let k = 0; k < m; k++) {
      if (plain[k] > nearest + 1e-12 * (own + norms[k] + Math.abs(nearest))) continue
      let d = -2 * gemm(x0, x1, centers[2 * k], centers[2 * k + 1]) + own + norms[k]
      if (!(d > 0)) d = 0
      d = Math.sqrt(d)
      if (d < least) {
        least = d
        best = k
      }
    }
    labels[s] = best
  }
  return { labels, centers }
}
