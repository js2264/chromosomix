/**
 * Two sequence sets against each other (SPECS §28): where they share sequence,
 * found from canonical minimizers, and the lines those matches make.
 *
 * **Matches.** Every canonical `k`-mer of both strands, `k = 19`, and of each
 * window of `w` consecutive ones the one whose hash is least — a minimizer —
 * on each side; the two lists sorted by hash (a radix sort, so nothing but
 * typed arrays is held) and **merge-joined**, which needs no hash table. A hash
 * seen more than {@link MAX_OCCURRENCES} times on either side is dropped, as
 * minimap2 drops its most frequent minimizers, so a repeat family is not a
 * square of noise. An **anchor** is one shared minimizer: a place on each axis,
 * and whether the two read it the same way round.
 *
 * **Streaks.** Anchors on one diagonal band — `x − y` the same way round,
 * `x + y` the other — with gaps under {@link STREAK_GAP} chain into a streak:
 * one line of the plot, with its anchors and its extent on both axes. Between
 * two assemblies they are kept {@link oneToOne}, each stretch at its best place.
 *
 * It is not an alignment, and writes none: a streak says two stretches share
 * enough exact 19-mers to be one line, and nothing about the bases between.
 */

/** The `k` of the `k`-mers matched. */
export const K = 19

/** A hash seen more often than this on either side is a repeat's, and dropped. */
export const MAX_OCCURRENCES = 50

/** The most minimizers the first set is sampled to: its window is chosen to stay under it. */
export const MINIMIZER_BUDGET = 2_000_000

/** Anchors of one streak are at most this far apart along either axis, in bases. */
export const STREAK_GAP = 5_000

/** How far off one diagonal an anchor may lie and still be the same streak's, in bases. */
export const STREAK_BAND = 500

/** The fewest anchors a streak is made of. */
export const LEAST_ANCHORS = 10

/** A set of sequences laid end to end on one axis. */
export interface SequenceSet {
  names: string[]
  lengths: number[]
  /** Where each sequence starts on the axis; one more than the names, the total last. */
  offsets: number[]
}

/** A set's layout from its sequences. */
export function sequenceSet(sequences: ReadonlyArray<{ name: string; length: number }>): SequenceSet {
  const offsets = [0]
  for (const sequence of sequences) offsets.push(offsets[offsets.length - 1] + sequence.length)
  return { names: sequences.map((sequence) => sequence.name), lengths: sequences.map((sequence) => sequence.length), offsets }
}

/** The window of `k`-mers a set of `total` bases is sampled at to stay under `budget` minimizers. */
export function windowFor(total: number, budget = MINIMIZER_BUDGET): number {
  // A random sequence's minimizers are about 2 / (w + 1) of its k-mers.
  return Math.max(1, Math.ceil((2 * total) / budget - 1))
}

/** Minimizers of a set, in the order they were found. */
export interface Minimizers {
  hash: Uint32Array
  /** Where each one's `k`-mer starts, on the set's axis: below 2³², four gigabases. */
  position: Uint32Array
  /** `1` where the forward `k`-mer is the canonical one, `-1` where its reverse complement is. */
  strand: Int8Array
  count: number
}

/** Two bits a base, `-1` for anything that is not one — which breaks every `k`-mer across it. */
const CODE = (() => {
  const code = new Int8Array(256).fill(-1)
  for (const [base, value] of [
    ['A', 0],
    ['C', 1],
    ['G', 2],
    ['T', 3],
  ] as const) {
    code[base.charCodeAt(0)] = value
    code[base.toLowerCase().charCodeAt(0)] = value
  }
  return code
})()

/** A 32-bit hash of a `k`-mer's 2-bit value, which may be up to 38 bits. */
function hashOf(value: number): number {
  const lo = value >>> 0
  const hi = Math.floor(value / 4294967296) >>> 0
  let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** A growable list of minimizers. */
class MinimizerList {
  hash = new Uint32Array(1024)
  position = new Uint32Array(1024)
  strand = new Int8Array(1024)
  count = 0
  push(hash: number, position: number, strand: number): void {
    if (this.count === this.hash.length) {
      const size = this.hash.length * 2
      const hashes = new Uint32Array(size)
      hashes.set(this.hash)
      this.hash = hashes
      const positions = new Uint32Array(size)
      positions.set(this.position)
      this.position = positions
      const strands = new Int8Array(size)
      strands.set(this.strand)
      this.strand = strands
    }
    this.hash[this.count] = hash
    this.position[this.count] = position
    this.strand[this.count] = strand
    this.count++
  }
  finish(): Minimizers {
    return { hash: this.hash.slice(0, this.count), position: this.position.slice(0, this.count), strand: this.strand.slice(0, this.count), count: this.count }
  }
}

/**
 * The canonical minimizers of every sequence of a set, `w` `k`-mers a window.
 *
 * @param read One sequence's bases, by name; `undefined` for one the reader
 *   has not got, which is left out.
 */
export function minimizersOf(set: SequenceSet, read: (name: string) => Uint8Array | undefined, w: number, k = K): Minimizers {
  const out = new MinimizerList()
  const top = 4 ** (k - 1)
  // The window, as a deque of k-mers by rising hash: the least is at its head.
  const dequeHash = new Float64Array(w + 1)
  const dequeAt = new Float64Array(w + 1)
  const dequeStrand = new Int8Array(w + 1)
  for (let s = 0; s < set.names.length; s++) {
    const bases = read(set.names[s])
    if (bases === undefined) continue
    const offset = set.offsets[s]
    let forward = 0
    let reverse = 0
    let run = 0
    // Ring-buffer deque over at most `w` entries.
    let head = 0
    let size = 0
    let lastAt = -1
    let kmers = 0
    const capacity = dequeHash.length
    for (let i = 0; i < bases.length; i++) {
      const c = CODE[bases[i]]
      if (c < 0) {
        run = 0
        size = 0
        kmers = 0
        continue
      }
      forward = (forward % top) * 4 + c
      reverse = Math.floor(reverse / 4) + (3 - c) * top
      run++
      if (run < k) continue
      const start = i - k + 1
      kmers++
      if (forward === reverse) continue
      const strand = forward < reverse ? 1 : -1
      const hash = hashOf(forward < reverse ? forward : reverse)
      // Drop from the tail every k-mer this one hashes at most as low as; from
      // the head every one that has left the window.
      while (size > 0 && dequeHash[(head + size - 1) % capacity] >= hash) size--
      dequeHash[(head + size) % capacity] = hash
      dequeAt[(head + size) % capacity] = start
      dequeStrand[(head + size) % capacity] = strand
      size++
      while (size > 0 && dequeAt[head] <= start - w) {
        head = (head + 1) % capacity
        size--
      }
      if (kmers < w) continue
      const at = dequeAt[head]
      if (at !== lastAt) {
        out.push(dequeHash[head], offset + at, dequeStrand[head])
        lastAt = at
      }
    }
  }
  return out.finish()
}

/**
 * The order of `keys`, rising: a least-significant-digit radix sort, sixteen
 * bits a pass — stable, so an order sorted by one key and then by another is
 * sorted by the second, then the first.
 *
 * @param from The order to start from, where not the keys' own.
 */
export function orderByKey(keys: Uint32Array, count = keys.length, from?: Uint32Array): Uint32Array {
  let order = new Uint32Array(count)
  if (from === undefined) for (let i = 0; i < count; i++) order[i] = i
  else order.set(from.subarray(0, count))
  let spare = new Uint32Array(count)
  const buckets = new Uint32Array(65537)
  for (const shift of [0, 16]) {
    buckets.fill(0)
    for (let i = 0; i < count; i++) buckets[((keys[order[i]] >>> shift) & 0xffff) + 1]++
    for (let b = 0; b < 65536; b++) buckets[b + 1] += buckets[b]
    for (let i = 0; i < count; i++) spare[buckets[(keys[order[i]] >>> shift) & 0xffff]++] = order[i]
    ;[order, spare] = [spare, order]
  }
  return order
}

/** Shared minimizers: a place on each axis and whether the two read them the same way round. */
export interface Anchors {
  x: Uint32Array
  y: Uint32Array
  /** `1` the same way round, `-1` the one the other's reverse complement. */
  strand: Int8Array
  count: number
  /** Hashes left out for being a repeat's on either side. */
  dropped: number
}

/**
 * The anchors two sets share: their minimizers merge-joined by hash, a hash
 * past `most` copies on either side dropped.
 */
export function anchorsOf(a: Minimizers, b: Minimizers, most = MAX_OCCURRENCES): Anchors {
  const oa = orderByKey(a.hash, a.count)
  const ob = orderByKey(b.hash, b.count)
  let x = new Uint32Array(1024)
  let y = new Uint32Array(1024)
  let strand = new Int8Array(1024)
  let count = 0
  let dropped = 0
  let i = 0
  let j = 0
  while (i < a.count && j < b.count) {
    const ha = a.hash[oa[i]]
    const hb = b.hash[ob[j]]
    if (ha < hb) {
      i++
      continue
    }
    if (hb < ha) {
      j++
      continue
    }
    let i1 = i
    while (i1 < a.count && a.hash[oa[i1]] === ha) i1++
    let j1 = j
    while (j1 < b.count && b.hash[ob[j1]] === hb) j1++
    if (i1 - i > most || j1 - j > most) {
      dropped++
    } else {
      for (let p = i; p < i1; p++) {
        for (let q = j; q < j1; q++) {
          if (count === x.length) {
            const size = x.length * 2
            const nx = new Uint32Array(size)
            nx.set(x)
            x = nx
            const ny = new Uint32Array(size)
            ny.set(y)
            y = ny
            const ns = new Int8Array(size)
            ns.set(strand)
            strand = ns
          }
          x[count] = a.position[oa[p]]
          y[count] = b.position[ob[q]]
          strand[count] = a.strand[oa[p]] === b.strand[ob[q]] ? 1 : -1
          count++
        }
      }
    }
    i = i1
    j = j1
  }
  return { x: x.slice(0, count), y: y.slice(0, count), strand: strand.slice(0, count), count, dropped }
}

/** One line of the plot: anchors along one diagonal, and where they lie on both axes. */
export interface Streak {
  /** On each set's own axis, half-open. */
  x0: number
  x1: number
  y0: number
  y1: number
  strand: 1 | -1
  anchors: number
}

/**
 * The streaks the anchors make: those on one diagonal band — `x − y` the same
 * way round, `x + y` the other — no more than `gap` apart along it, at least
 * `least` of them.
 *
 * @param member Where given, one entry an anchor, set to the index in the
 *   list returned of the streak it is part of, `-1` for one of none — a
 *   chance match, which the figure leaves out.
 */
export function streaksOf(anchors: Anchors, gap = STREAK_GAP, band = STREAK_BAND, least = LEAST_ANCHORS, member?: Int32Array): Streak[] {
  const out: Streak[] = []
  member?.fill(-1)
  let yMost = 0
  for (let i = 0; i < anchors.count; i++) if (anchors.y[i] > yMost) yMost = anchors.y[i]
  for (const strand of [1, -1] as const) {
    // By band of the diagonal, then along it: two stable radix sorts, along it
    // first — millions of anchors, and a comparator sort of them is seconds.
    let count = 0
    for (let i = 0; i < anchors.count; i++) if (anchors.strand[i] === strand) count++
    const index = new Uint32Array(count)
    const along = new Uint32Array(count)
    const bands = new Uint32Array(count)
    // A band index, never negative: `x − y` shifted by the most `y` is.
    const shift = Math.ceil(yMost / band) + 1
    for (let i = 0, k = 0; i < anchors.count; i++) {
      if (anchors.strand[i] !== strand) continue
      index[k] = i
      along[k] = anchors.x[i]
      bands[k] = strand === 1 ? Math.round((anchors.x[i] - anchors.y[i]) / band) + shift : Math.round((anchors.x[i] + anchors.y[i]) / band)
      k++
    }
    const order = orderByKey(bands, count, orderByKey(along, count))
    const picked = new Uint32Array(count)
    const pickedBand = new Uint32Array(count)
    for (let k = 0; k < count; k++) {
      picked[k] = index[order[k]]
      pickedBand[k] = bands[order[k]]
    }
    let first = 0
    const close = (end: number): void => {
      const n = end - first
      if (n >= least) {
        let x0 = Number.POSITIVE_INFINITY
        let x1 = Number.NEGATIVE_INFINITY
        let y0 = Number.POSITIVE_INFINITY
        let y1 = Number.NEGATIVE_INFINITY
        for (let k = first; k < end; k++) {
          const i = picked[k]
          x0 = Math.min(x0, anchors.x[i])
          x1 = Math.max(x1, anchors.x[i] + K)
          y0 = Math.min(y0, anchors.y[i])
          y1 = Math.max(y1, anchors.y[i] + K)
        }
        if (member !== undefined) for (let k = first; k < end; k++) member[picked[k]] = out.length
        out.push({ x0, x1, y0, y1, strand, anchors: n })
      }
      first = end
    }
    for (let k = 1; k <= picked.length; k++) {
      if (k === picked.length) {
        close(k)
        break
      }
      const p = picked[k - 1]
      const q = picked[k]
      if (pickedBand[k - 1] !== pickedBand[k] || anchors.x[q] - anchors.x[p] > gap) close(k)
    }
  }
  // Along x, and an anchor's streak renumbered to its place in that order.
  const order = out.map((_, i) => i).sort((p, q) => out[p].x0 - out[q].x0 || out[p].y0 - out[q].y0)
  if (member !== undefined) {
    const rank = new Int32Array(out.length)
    order.forEach((i, place) => (rank[i] = place))
    for (let i = 0; i < anchors.count; i++) if (member[i] >= 0) member[i] = rank[member[i]]
  }
  return order.map((i) => out[i])
}

/** The finest step, in bases, along which {@link oneToOne} marks what a streak has taken. */
const ONE_TO_ONE_STEP = 100

/** The most steps along an axis {@link oneToOne} marks: coarser than a hundred bases past forty megabases. */
const ONE_TO_ONE_STEPS = 400_000

/**
 * The streaks kept one to one: strongest first, each kept unless most of its
 * stretch along either axis is already a stronger kept one's — each stretch
 * of one set at its best place in the other, as `delta-filter -1` keeps
 * MUMmer's alignments. A repeat's copies meet every other copy; one to one,
 * each keeps the place its flanks put it and loses the others, and the grid
 * a repeat family draws between two assemblies goes with them.
 *
 * @returns One entry a streak, `1` for each kept.
 */
export function oneToOne(streaks: readonly Streak[], a: SequenceSet, b: SequenceSet): Uint8Array {
  const totalA = a.offsets[a.offsets.length - 1]
  const totalB = b.offsets[b.offsets.length - 1]
  const step = Math.max(ONE_TO_ONE_STEP, Math.ceil(Math.max(totalA, totalB) / ONE_TO_ONE_STEPS))
  const takenX = new Uint8Array(Math.ceil(totalA / step) + 1)
  const takenY = new Uint8Array(Math.ceil(totalB / step) + 1)
  const stepsOf = (from: number, to: number): [number, number] => {
    const first = Math.floor(from / step)
    return [first, Math.max(first + 1, Math.ceil(to / step))]
  }
  const share = (taken: Uint8Array, from: number, to: number): number => {
    const [first, end] = stepsOf(from, to)
    let n = 0
    for (let c = first; c < end; c++) n += taken[c]
    return n / (end - first)
  }
  const take = (taken: Uint8Array, from: number, to: number): void => {
    const [first, end] = stepsOf(from, to)
    taken.fill(1, first, end)
  }
  const kept = new Uint8Array(streaks.length)
  const order = streaks.map((_, i) => i).sort((p, q) => streaks[q].anchors - streaks[p].anchors || p - q)
  for (const i of order) {
    const streak = streaks[i]
    if (share(takenX, streak.x0, streak.x1) > 0.5 || share(takenY, streak.y0, streak.y1) > 0.5) continue
    kept[i] = 1
    take(takenX, streak.x0, streak.x1)
    take(takenY, streak.y0, streak.y1)
  }
  return kept
}

/**
 * The anchors on a grid, signed: `+1` a cell for each the same way round, `−1`
 * the other — those `only` marks, where it is given.
 */
export function densityOf(
  anchors: Anchors,
  a: SequenceSet,
  b: SequenceSet,
  cells: number,
  only?: Uint8Array,
): { values: Float32Array; ncols: number; nrows: number; cellSize: number } {
  const totalA = a.offsets[a.offsets.length - 1]
  const totalB = b.offsets[b.offsets.length - 1]
  // Square in bases: the longer axis gets `cells`.
  const cellSize = Math.max(1, Math.ceil(Math.max(totalA, totalB) / Math.max(1, cells)))
  const ncols = Math.max(1, Math.ceil(totalA / cellSize))
  const nrows = Math.max(1, Math.ceil(totalB / cellSize))
  const values = new Float32Array(ncols * nrows)
  for (let i = 0; i < anchors.count; i++) {
    if (only !== undefined && only[i] !== 1) continue
    const col = Math.min(ncols - 1, Math.floor(anchors.x[i] / cellSize))
    const row = Math.min(nrows - 1, Math.floor(anchors.y[i] / cellSize))
    values[row * ncols + col] += anchors.strand[i]
  }
  return { values, ncols, nrows, cellSize }
}

/** The sequence of a set a place on its axis is in, and where in it. */
export function locate(set: SequenceSet, position: number): { sequence: number; at: number } {
  let low = 0
  let high = set.names.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (set.offsets[mid] <= position) low = mid
    else high = mid - 1
  }
  return { sequence: low, at: position - set.offsets[low] }
}
