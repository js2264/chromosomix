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
 * chromosome.
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

/** Count A, C, G and T in consecutive steps of `step` bases. */
export function baseCounts(seq: Uint8Array, step: number): BaseCounts {
  const width = Math.max(1, Math.round(step))
  const steps = seq.length === 0 ? 0 : Math.ceil(seq.length / width)
  const a = new Int32Array(steps)
  const c = new Int32Array(steps)
  const g = new Int32Array(steps)
  const t = new Int32Array(steps)
  for (let slot = 0; slot < steps; slot++) {
    const from = slot * width
    const to = Math.min(seq.length, from + width)
    let na = 0
    let nc = 0
    let ng = 0
    let nt = 0
    for (let i = from; i < to; i++) {
      // `BASE_CODE` is 0 A, 1 C, 2 G, 3 T/U and 4 anything else, case-folded.
      switch (BASE_CODE[seq[i]]) {
        case 0:
          na++
          break
        case 1:
          nc++
          break
        case 2:
          ng++
          break
        case 3:
          nt++
          break
      }
    }
    a[slot] = na
    c[slot] = nc
    g[slot] = ng
    t[slot] = nt
  }
  return { step: width, steps, a, c, g, t }
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
