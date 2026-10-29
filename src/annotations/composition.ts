/**
 * Base composition along a sequence: GC content, GC skew and AT skew.
 *
 * Three numbers a bacterial genome is read by before anything else is looked
 * at. **GC content** is the fraction of a stretch that is G or C, and a stretch
 * that departs from its genome's own figure is usually a horizontally acquired
 * island. **GC skew**, `(G − C) / (G + C)`, is the imbalance between the two
 * strands, and it is the one that carries replication: the leading strand is
 * richer in G than in C, the forward strand leads on one replichore and lags on
 * the other, so the skew changes sign at the origin and again at the terminus
 * (Lobry 1996). **AT skew**, `(A − T) / (A + T)`, is the same question asked of
 * the other pair and is weaker in most genomes, which is itself worth seeing.
 *
 * Pure and byte-level, like `annotations/fasta.ts` beside it: one pass over the
 * residues counts each base per step, and every window after that is a sum of
 * whole steps. That is the whole of the arithmetic, and it is why a windowed
 * profile costs the same as an unwindowed one — the residues are read once, and
 * a window of fifty steps is fifty additions per step, never fifty passes over a
 * chromosome. The pass needs the residues a few megabases at a time and no more
 * ({@link readBaseCounts}), so a genome read by range is counted without being
 * held.
 *
 * Only `A`, `C`, `G` and `T` (and `U`) are counted, in either case. An `N` is a
 * base nobody knows and counts towards nothing, so a window that is all gap
 * answers `NaN` — *no value here* — rather than a skew of zero, which would
 * claim the two strands had been measured and found equal.
 */

import { BASE_CODE } from './fasta'

/**
 * How many of each base fall in each step of a sequence, in reading order.
 *
 * `steps` is `ceil(length / step)`: the last step is partial exactly as the last
 * bin of a contact map is, which is what lets a profile built from these counts
 * be registered on a map's own grid bin for bin.
 */
export interface BaseCounts {
  step: number
  steps: number
  a: Int32Array
  c: Int32Array
  g: Int32Array
  t: Int32Array
}

/**
 * Each byte as four 8-bit counts in one word — A in the lowest byte, then C, G
 * and T — and nothing at all for any other byte.
 *
 * Counting is then addition: a stretch's word is the sum of its bytes' words,
 * and one split of the sum into its four bytes is its four counts, as long as
 * no count passes 255 before it is split. Where a `switch` on each base was a
 * branch the processor could not predict — the next base of a genome is as
 * good as random — this is a load and an add, and it counts a mammalian genome
 * in a second where the branches took half a minute.
 */
let packed: Uint32Array | null = null
/** The same for two bytes at once, indexed by both: one lookup per 16 bits read. */
let pairs: Uint32Array | null = null

function packedTables(): [Uint32Array, Uint32Array] {
  if (packed === null || pairs === null) {
    packed = new Uint32Array(256)
    // `BASE_CODE` is 0 A, 1 C, 2 G, 3 T/U and 4 anything else, case-folded.
    for (let byte = 0; byte < 256; byte++) {
      const code = BASE_CODE[byte]
      packed[byte] = code < 4 ? 1 << (8 * code) : 0
    }
    // The sum of the two bytes' words, which reads the same either way round,
    // so the order a 16-bit read puts them in — the platform's — does not matter.
    pairs = new Uint32Array(65_536)
    for (let both = 0; both < 65_536; both++) pairs[both] = packed[both & 0xff] + packed[both >>> 8]
  }
  return [packed, pairs]
}

/**
 * Words of four bytes per inner run: four counts a word, so 63 of them is at
 * most 252 of any base, and no count overflows its byte before it is split.
 */
const RUN_WORDS = 63

/** Count A, C, G and T in consecutive steps of `step` bases. */
export function baseCounts(seq: Uint8Array, step: number): BaseCounts {
  const width = Math.max(1, Math.round(step))
  const steps = seq.length === 0 ? 0 : Math.ceil(seq.length / width)
  const a = new Int32Array(steps)
  const c = new Int32Array(steps)
  const g = new Int32Array(steps)
  const t = new Int32Array(steps)
  const [byByte, byPair] = packedTables()
  // The residues four at a time wherever they are aligned to four in their
  // buffer, which a 32-bit view needs: `lead` bytes before the first such word,
  // and a step's ends either side of its first and last word, a byte at a time.
  const lead = (4 - (seq.byteOffset & 3)) & 3
  const words = new Uint32Array(seq.buffer, seq.byteOffset + lead, Math.max(0, (seq.length - lead) >> 2))
  for (let slot = 0; slot < steps; slot++) {
    const from = slot * width
    const to = Math.min(seq.length, from + width)
    const aligned = Math.min(to, from <= lead ? lead : lead + (((from - lead + 3) >> 2) << 2))
    const whole = (to - aligned) >> 2
    // The ends: three bytes at most on either side, which fit a word together.
    let ends = 0
    for (let i = from; i < aligned; i++) ends += byByte[seq[i]]
    for (let i = aligned + 4 * whole; i < to; i++) ends += byByte[seq[i]]
    let na = ends & 0xff
    let nc = (ends >>> 8) & 0xff
    let ng = (ends >>> 16) & 0xff
    let nt = ends >>> 24
    let w = (aligned - lead) >> 2
    const last = w + whole
    while (w < last) {
      const stop = Math.min(last, w + RUN_WORDS)
      let sum = 0
      for (; w < stop; w++) {
        const word = words[w]
        sum += byPair[word & 0xffff] + byPair[word >>> 16]
      }
      na += sum & 0xff
      nc += (sum >>> 8) & 0xff
      ng += (sum >>> 16) & 0xff
      nt += sum >>> 24
    }
    a[slot] = na
    c[slot] = nc
    g[slot] = ng
    t[slot] = nt
  }
  return { step: width, steps, a, c, g, t }
}

/**
 * Residues a window of {@link readBaseCounts} holds at most: a few megabases,
 * read and let go. Small enough that the array each read makes is memory the
 * allocator has just had back from the last, rather than pages the system has
 * to find and zero again — which, for a sequence read whole, cost more than
 * counting it.
 */
export const COUNT_WINDOW = 1 << 22

/**
 * Residues one read of {@link readBaseCounts} asks for: a whole number of
 * steps, as many as fit in `window`, and one where none does. Its own function
 * so the price beside **Run** (`analysis/tasks/composition.ts`) counts the
 * reads the run makes.
 */
export function countSpan(step: number, window = COUNT_WINDOW): number {
  const width = Math.max(1, Math.round(step))
  return width * Math.max(1, Math.floor(window / width))
}

/**
 * {@link baseCounts} of a sequence read through `read` a window at a time,
 * and how many residues it has.
 *
 * `read` answers residues `[start, end)` clipped to the sequence, as a
 * reference read by range does (`SequenceReader.read`), or `undefined` for a
 * sequence it has not got. Every window but the last is a whole number of
 * steps, so each step is counted in one window and the counts are those of the
 * sequence read whole; a window shorter than asked for is the end of it, which
 * is how the length is learnt without being asked for.
 */
export async function readBaseCounts(
  read: (start: number, end: number) => Promise<Uint8Array | undefined>,
  step: number,
  window = COUNT_WINDOW,
): Promise<{ counts: BaseCounts; length: number } | undefined> {
  const width = Math.max(1, Math.round(step))
  const span = countSpan(width, window)
  const pieces: BaseCounts[] = []
  let length = 0
  for (let start = 0; ; start += span) {
    const piece = await read(start, start + span)
    if (piece === undefined) return undefined
    pieces.push(baseCounts(piece, width))
    length += piece.length
    if (piece.length < span) break
  }
  const steps = pieces.reduce((sum, piece) => sum + piece.steps, 0)
  const counts: BaseCounts = {
    step: width,
    steps,
    a: new Int32Array(steps),
    c: new Int32Array(steps),
    g: new Int32Array(steps),
    t: new Int32Array(steps),
  }
  let at = 0
  for (const piece of pieces) {
    counts.a.set(piece.a, at)
    counts.c.set(piece.c, at)
    counts.g.set(piece.g, at)
    counts.t.set(piece.t, at)
    at += piece.steps
  }
  return { counts, length }
}

/**
 * The counts summed over `span` consecutive steps centred on each step.
 *
 * `span` is made odd, so a window has a centre and the profile is not shifted
 * half a step to one side. On a **circle** the window wraps round the origin,
 * which is the one place a bacterial skew changes sign and therefore the one
 * place a window clipped at the end of the array would lie; on a **line** it is
 * clipped, and the steps near each end are measured over what is there.
 */
export function windowCounts(counts: BaseCounts, span: number, circular: boolean): BaseCounts {
  const half = Math.max(0, Math.floor(Math.max(1, Math.round(span)) / 2))
  const n = counts.steps
  if (half === 0 || n === 0) return counts
  const sum = (source: Int32Array): Int32Array => {
    const out = new Int32Array(n)
    // Prefix sums over one lap, so a window is two lookups however wide it is.
    const prefix = new Float64Array(n + 1)
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + source[i]
    const total = prefix[n]
    const upTo = (at: number): number => {
      // Sum of steps `[0, at)`, with `at` allowed to run a lap either way on a
      // circle — which a window near the origin of a small plasmid can.
      if (!circular) return prefix[Math.max(0, Math.min(n, at))]
      const laps = Math.floor(at / n)
      return laps * total + prefix[at - laps * n]
    }
    for (let i = 0; i < n; i++) {
      // Never wider than the sequence: a window of a whole lap is every base
      // once, and wider would count some of them twice.
      const lo = circular ? i - Math.min(half, Math.floor((n - 1) / 2)) : i - half
      const hi = circular ? i + Math.min(half, Math.floor((n - 1) / 2)) + 1 : i + half + 1
      out[i] = upTo(hi) - upTo(lo)
    }
    return out
  }
  return { ...counts, a: sum(counts.a), c: sum(counts.c), g: sum(counts.g), t: sum(counts.t) }
}

/** `(G + C) / (A + C + G + T)` per step; `NaN` where nothing was counted. */
export function gcContentOf(counts: BaseCounts): Float32Array {
  const out = new Float32Array(counts.steps)
  for (let i = 0; i < counts.steps; i++) {
    const gc = counts.g[i] + counts.c[i]
    const all = gc + counts.a[i] + counts.t[i]
    out[i] = all > 0 ? gc / all : Number.NaN
  }
  return out
}

/** `(G − C) / (G + C)` per step; `NaN` where there is neither. */
export function gcSkewOf(counts: BaseCounts): Float32Array {
  const out = new Float32Array(counts.steps)
  for (let i = 0; i < counts.steps; i++) {
    const both = counts.g[i] + counts.c[i]
    out[i] = both > 0 ? (counts.g[i] - counts.c[i]) / both : Number.NaN
  }
  return out
}

/** `(A − T) / (A + T)` per step; `NaN` where there is neither. */
export function atSkewOf(counts: BaseCounts): Float32Array {
  const out = new Float32Array(counts.steps)
  for (let i = 0; i < counts.steps; i++) {
    const both = counts.a[i] + counts.t[i]
    out[i] = both > 0 ? (counts.a[i] - counts.t[i]) / both : Number.NaN
  }
  return out
}

/**
 * The running sum of a per-step value along the sequence.
 *
 * The cumulative GC skew, when handed the skew: it falls along the replichore
 * the forward strand lags on and rises along the one it leads on, so its
 * **minimum is the origin and its maximum the terminus** whatever position the
 * assembly happens to start at (Grigoriev 1998) — a turning point is far easier
 * to place than a sign change in a noisy trace. A gap adds nothing and does not
 * interrupt the sum: the curve is a position, and a stretch nobody could read
 * leaves it where it was rather than breaking it.
 */
export function cumulativeOf(values: Float32Array): Float32Array {
  const out = new Float32Array(values.length)
  let total = 0
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (Number.isFinite(value)) total += value
    out[i] = total
  }
  return out
}
