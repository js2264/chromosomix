/**
 * Pearson's *r* between every pair of rows of a square, over the cells both rows
 * have — the correlation matrix of §18.6, fast enough to draw at 4,096 bins.
 *
 * It was computed pair by pair with `stats.ts`'s `pearson`: two passes over two
 * rows for each of `m²/2` pairs, a `NaN` test on every cell of both, in scalar
 * JavaScript. That is right and slow — 2.8 s at 929 bins, and three minutes at
 * 4,096, where the map's correlation was capped at 1,500 because nobody should be
 * asked to wait longer for a toggle. The arithmetic is the same here and is
 * organised differently.
 *
 * **One product, and a few numbers per pair.** Over the cells a pair shares, `r`
 * needs six sums: the pair's products, how many cells there are, and each row's
 * sum and sum of squares over them. Only the first depends on both rows at every
 * cell; the other five are each row's own totals, less what the *other* row is
 * missing. So every row is read once, a missing cell is written as zero, and
 *
 * - the products of every pair are one matrix product — the rows against
 *   themselves, `m³/2` multiply-adds — done by a WebAssembly kernel with SIMD
 *   (`wasm/gram.c`) at ten to thirteen billion a second on one core, the more
 *   where the engine fuses the multiply-add, where the pairwise loop managed a
 *   fifth of a billion;
 * - the other five are each row's totals, corrected pair by pair for the few
 *   cells the other row lacks — a handful on a balanced map, where a bin the
 *   balancer dropped is dropped from both sides of the square and what is left
 *   missing is the odd cell with no expectation, or the diagonals the
 *   compartment chain ignores.
 *
 * A square where rows miss whole stretches — a trans-only compartment run blanks
 * every sequence's own block — would make those corrections as costly as the
 * product, so there the kernel sums all six over the shared cells in one masked
 * pass instead (`gram_masked`), about seven times the work of the plain product
 * and still far below the pairwise loop. What the corrections cost between the
 * two is real: a square with a few hundred cells missing from every row — the
 * map's O/E of a sparse map did, when its empty pixels were blank — is several
 * times the product either way, which is why the map correlates a ratio whose
 * empty pixels are zeros (`render/derive.ts`'s `keepZeros`).
 *
 * The work comes in **bands** of rows, each the band's rows against every row
 * after them, so a band can be handed to another thread with only the rows it
 * reads (`pearsonThreads.ts`), and a caller hears about every row as its band
 * finishes.
 *
 * **Precision.** `stats.ts` computes `r` in two passes because the one-pass form,
 * built from `Σx`, `Σx²` and `Σxy`, loses its significant digits when the mean is
 * large next to the spread — which is an observed/expected row, centred on one.
 * Each row here is shifted by its own mean before anything is summed, and `r` is
 * blind to such a shift, so the sums are of numbers centred on zero and nothing
 * large cancels: the pair's own mean differs from the row's only through the few
 * cells the other row is missing. The rows are held as `float` and each block of
 * 512 cells is summed in `float` lanes before it reaches a `double`, so `r` agrees
 * with the two-pass `double` computation to about 1e-6 — below anything a
 * colour ramp or an eigenvector can show.
 *
 * **What it gives back** is the same as before: `NaN` for a pair with fewer than
 * {@link MIN_PAIRS} cells in common or a row with no spread over them, which the
 * callers read as *no evidence* — and each row's line is handed over as soon as
 * it is done, so neither caller holds a second copy of the square.
 */

import { MIN_PAIRS } from './stats'
import { GRAM_RELAXED_WASM_BASE64, GRAM_WASM_BASE64 } from './wasm/gram.generated'

/**
 * The cells summed per kernel call along a row. 512 floats is 2 KB a row, so the
 * rows being multiplied stay in the first-level cache while the band passes over
 * them; measured at 2,048 bins, 256 and 1,024 are both slower.
 */
const K_BLOCK = 512
/** The rows multiplied against a band per kernel call: 256 × 2 KB, a second-level cache's worth. */
const B_BLOCK = 256
/**
 * The rows of the output computed per pass, and so the step progress is reported
 * and a cancel is heard at: the first band of a 4,096-bin square is about a
 * tenth of a second on one core.
 */
export const BAND = 64

/**
 * A row whose spread over the shared cells is below this fraction of its sum of
 * squares has none: the exact computation would divide by a zero that rounding
 * has made a very small number.
 */
const FLAT = 1e-9

/** The square, a row at a time. */
export interface PearsonInput {
  /** Rows, and columns: the square is `m × m`. */
  m: number
  /** Row `r`'s `m` cells into `into`, anything but a finite number where it has none. */
  row(r: number, into: Float64Array): void
}

/**
 * Row `a`'s correlations with every later row, in `line[a + 1 .. m)`, handed over
 * once per row and in order. `NaN` where a pair has no correlation.
 */
export type PearsonOutput = (a: number, line: Float64Array) => void

/**
 * Which arithmetic runs the product: the fastest WebAssembly kernel this engine
 * runs, the one with SIMD alone — what an engine without relaxed SIMD gets, and
 * what the tests hold beside it — or the same loops in JavaScript.
 */
export type PearsonEngine = 'wasm' | 'simd' | 'js'

/**
 * Rows `[first, m)` of a square, read and ready to be correlated — everything a
 * band needs, and so everything a thread computing bands is sent
 * (`pearsonThreads.ts`).
 */
export interface PreparedRows {
  /** The square's side. */
  m: number
  /** Floats between one row and the next: `m` rounded up to a multiple of four. */
  ld: number
  /** The first row held; every array below starts at it. */
  first: number
  /**
   * Whether the rows are in the masked kernel's form — `NaN` where a cell is
   * missing — because too many are for pair-by-pair corrections to be cheaper.
   * Otherwise a missing cell is zero, and `starts`/`cols` list them.
   */
  masked: boolean
  /** Each row's finite cells, their sum and their sum of squares — of the shifted, stored values. */
  count: Float64Array
  sum: Float64Array
  squares: Float64Array
  /** Row `first + i`'s missing columns are `cols[starts[i] .. starts[i + 1])`, sorted; empty when masked. */
  starts: Int32Array
  cols: Int32Array
}

/**
 * Correlate every pair of rows, on this thread.
 *
 * `onRow` is called for every row, in order, before its correlations are
 * computed, and **awaited** — which is what lets a caller report progress and
 * stop it by throwing (`analysis/job.ts`'s `breathe` explains why the yield has
 * to be inside the loop).
 */
export async function pearsonRows(
  input: PearsonInput,
  output: PearsonOutput,
  onRow?: (row: number) => void | Promise<void>,
  options: { engine?: PearsonEngine } = {},
): Promise<void> {
  const m = input.m
  if (m <= 0) return
  const { engine, rows } = readSquare(input, options.engine ?? 'wasm')
  const line = new Float64Array(m)
  for (let r0 = 0; r0 < m; r0 += BAND) {
    const r1 = Math.min(m, r0 + BAND)
    if (onRow !== undefined) {
      for (let r = r0; r < r1; r++) {
        const waiting = onRow(r)
        if (waiting !== undefined) await waiting
      }
    }
    correlateBand(engine, rows, r0, r1, line, output)
  }
}

/** The floats between one row and the next: `m` rounded up to whole vectors of four. */
export function strideOf(m: number): number {
  return (m + 3) & ~3
}

/**
 * Read the whole square into an engine's storage, in the form the product it
 * needs wants: the first step of every road, threaded or not.
 */
export function readSquare(
  input: PearsonInput,
  wanted: PearsonEngine = 'wasm',
): { engine: RowsEngine; rows: PreparedRows } {
  const m = input.m
  const ld = strideOf(m)
  const engine = makeEngine(wanted, ld, m)
  const x = engine.x
  const count = new Float64Array(m)
  const sum = new Float64Array(m)
  const squares = new Float64Array(m)
  // Past an eighth of the square missing, the corrections cost more than the
  // masked pass: each is a gather per missing cell per pair, against seven
  // multiply-adds per cell per pair in the kernel, which runs about eight times
  // faster than a gather.
  const limit = Math.floor((m * m) / 8)
  const starts = new Int32Array(m + 1)
  let cols = new Int32Array(Math.min(limit, Math.max(64, m)))
  let listed = 0
  let masked = false
  const scratch = new Float64Array(m)
  for (let r = 0; r < m; r++) {
    input.row(r, scratch)
    let total = 0
    let seen = 0
    for (let c = 0; c < m; c++) {
      const value = scratch[c]
      if (Number.isFinite(value)) {
        total += value
        seen++
      }
    }
    const mean = seen > 0 ? total / seen : 0
    starts[r] = listed
    const base = r * ld
    let s = 0
    let q = 0
    for (let c = 0; c < m; c++) {
      const value = scratch[c]
      if (Number.isFinite(value)) {
        const shifted = Math.fround(value - mean)
        x[base + c] = shifted
        s += shifted
        q += shifted * shifted
        continue
      }
      // `NaN` for now, which is the masked kernel's form; the plain one's is
      // made from it below, once it is known which is wanted.
      x[base + c] = Number.NaN
      if (masked) continue
      if (listed === limit) {
        masked = true
        continue
      }
      if (listed === cols.length) {
        const grown = new Int32Array(Math.min(limit, cols.length * 2))
        grown.set(cols)
        cols = grown
      }
      cols[listed++] = c
    }
    for (let c = m; c < ld; c++) x[base + c] = Number.NaN
    count[r] = seen
    sum[r] = s
    squares[r] = q
  }
  starts[m] = listed
  if (!masked) {
    // The plain kernel wants a missing cell, and the padding, as zero.
    for (let r = 0; r < m; r++) {
      for (let at = starts[r]; at < starts[r + 1]; at++) x[r * ld + cols[at]] = 0
      for (let c = m; c < ld; c++) x[r * ld + c] = 0
    }
  }
  return {
    engine,
    rows: {
      m,
      ld,
      first: 0,
      masked,
      count,
      sum,
      squares,
      starts: masked ? new Int32Array(m + 1) : starts,
      cols: masked ? new Int32Array(0) : cols.subarray(0, listed),
    },
  }
}

/**
 * The correlations of rows `[r0, r1)` with every row after each, handed to
 * `output` a row at a time through `line`. The engine holds rows from
 * `rows.first` on, which must be no later than `r0`.
 */
export function correlateBand(
  engine: RowsEngine,
  rows: PreparedRows,
  r0: number,
  r1: number,
  line: Float64Array,
  output: PearsonOutput,
): void {
  const { m, first } = rows
  const held = m - first
  engine.run(r0 - first, r1 - first, rows.masked)
  const out = engine.out
  for (let a = r0; a < r1; a++) {
    const g = (a - r0) * held - first
    if (rows.masked) {
      const size = BAND * held
      for (let b = a + 1; b < m; b++) {
        const at = g + b
        line[b] = correlation(
          out[at],
          out[size + at],
          out[2 * size + at],
          out[3 * size + at],
          out[4 * size + at],
          out[5 * size + at],
        )
      }
    } else {
      sparseLine(a, engine.x, rows, out, g, line)
    }
    output(a, line)
  }
}

/**
 * Row `a`'s correlations from the product band and the corrections: each row's
 * totals, less its cells at the columns the other row is missing.
 */
function sparseLine(a: number, x: Float32Array, rows: PreparedRows, band: Float64Array, g: number, line: Float64Array): void {
  const { m, ld, first, count, sum, squares, starts, cols } = rows
  const ia = a - first
  const aFrom = starts[ia]
  const aTo = starts[ia + 1]
  const aBase = ia * ld
  for (let b = a + 1; b < m; b++) {
    const ib = b - first
    let n = count[ia]
    let sa = sum[ia]
    let qa = squares[ia]
    let sb = sum[ib]
    let qb = squares[ib]
    const bFrom = starts[ib]
    const bTo = starts[ib + 1]
    if (bTo > bFrom) {
      // Row a's cells at b's gaps come out of a's totals. Where a is missing
      // too, the stored zero takes nothing out, and the merge below counts it.
      for (let at = bFrom; at < bTo; at++) {
        const value = x[aBase + cols[at]]
        sa -= value
        qa -= value * value
      }
      n -= bTo - bFrom
    }
    if (aTo > aFrom) {
      const bBase = ib * ld
      for (let at = aFrom; at < aTo; at++) {
        const value = x[bBase + cols[at]]
        sb -= value
        qb -= value * value
      }
      // Columns both are missing were taken off a's count once above as b's
      // gaps; they were never among a's cells, so they are given back.
      if (bTo > bFrom) n += shared(cols, aFrom, aTo, bFrom, bTo)
    }
    line[b] = correlation(band[g + b], n, sa, sb, qa, qb)
  }
}

/** How many columns two sorted runs of `cols` have in common. */
function shared(cols: Int32Array, i0: number, i1: number, j0: number, j1: number): number {
  let both = 0
  let i = i0
  let j = j0
  while (i < i1 && j < j1) {
    const u = cols[i]
    const v = cols[j]
    if (u === v) {
      both++
      i++
      j++
    } else if (u < v) i++
    else j++
  }
  return both
}

/** `r` from the six sums over the shared cells, or `NaN` where it has none. */
function correlation(p: number, n: number, sa: number, sb: number, qa: number, qb: number): number {
  if (!(n >= MIN_PAIRS)) return Number.NaN
  const va = qa - (sa * sa) / n
  const vb = qb - (sb * sb) / n
  if (!(va > FLAT * qa) || !(vb > FLAT * qb)) return Number.NaN
  const r = (p - (sa * sb) / n) / Math.sqrt(va * vb)
  return r > 1 ? 1 : r < -1 ? -1 : r
}

// ---------------------------------------------------------------------------
// The product
// ---------------------------------------------------------------------------

/** Where the rows are held, and the arithmetic over them. */
export interface RowsEngine {
  /** The rows held, `ld` floats apart, counted from the first held. */
  readonly x: Float32Array
  /** The band's sums: one `BAND × held` block for the plain product, six for the masked one. */
  readonly out: Float64Array
  /** Fill the band for held rows `[r0, r1)` against every held row from `r0` on. */
  run(r0: number, r1: number, masked: boolean): void
}

type Kernel = (
  x: number,
  y: number,
  ld: number,
  out: number,
  ldg: number,
  g0: number,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  k0: number,
  k1: number,
) => void

type MaskedKernel = (
  x: number,
  ld: number,
  out: number,
  ldg: number,
  size: number,
  g0: number,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  k0: number,
  k1: number,
) => void

/**
 * The kernel's two builds, compiled once per thread; each `null` where this
 * engine cannot run it — relaxed SIMD is newer than SIMD, and an engine with
 * neither has no kernel at all.
 */
let compiled: { relaxed: WebAssembly.Module | null; simd: WebAssembly.Module | null } | undefined

function compile(base64: string): WebAssembly.Module | null {
  try {
    if (typeof WebAssembly === 'undefined') return null
    const text = atob(base64)
    const bytes = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
    // `validate` is false on an engine without the instructions a build uses,
    // which is the one way either can fail to load where WebAssembly exists.
    return WebAssembly.validate(bytes) ? new WebAssembly.Module(bytes) : null
  } catch {
    return null
  }
}

/** The build `wanted` names: the relaxed one where it runs, for `wasm`. */
function gramModule(wanted: 'wasm' | 'simd'): WebAssembly.Module | null {
  compiled ??= { relaxed: compile(GRAM_RELAXED_WASM_BASE64), simd: compile(GRAM_WASM_BASE64) }
  return wanted === 'wasm' ? (compiled.relaxed ?? compiled.simd) : compiled.simd
}

/** Whether the WebAssembly kernel can run here, and which build — for the notes and the tests. */
export function gramKernelAvailable(build: 'wasm' | 'simd' | 'relaxed' = 'wasm'): boolean {
  if (build === 'relaxed') {
    gramModule('wasm')
    return compiled?.relaxed != null
  }
  return gramModule(build) !== null
}

/**
 * Storage for `held` rows, `ld` floats each, and the arithmetic over them.
 * Sized for the masked product's six output bands whichever runs — they are a
 * few megabytes, and which product a square needs is only known once it has
 * been read into this storage.
 */
export function makeEngine(wanted: PearsonEngine, ld: number, held: number): RowsEngine {
  const module = wanted === 'js' ? null : gramModule(wanted)
  if (module !== null) {
    try {
      return wasmEngine(module, ld, held)
    } catch {
      // Memory the size of the square could not be had in one piece: the same
      // arithmetic in JavaScript needs none.
    }
  }
  return jsEngine(ld, held)
}

const PAGE = 65536

function wasmEngine(module: WebAssembly.Module, ld: number, held: number): RowsEngine {
  const xBytes = held * ld * 4
  const outAt = Math.ceil(xBytes / 8) * 8
  const outLength = 6 * BAND * held
  const memory = new WebAssembly.Memory({ initial: Math.ceil((outAt + outLength * 8) / PAGE) + 1 })
  const instance = new WebAssembly.Instance(module, { env: { memory } })
  const gram = instance.exports.gram as Kernel
  const masked = instance.exports.gram_masked as MaskedKernel
  const x = new Float32Array(memory.buffer, 0, held * ld)
  const out = new Float64Array(memory.buffer, outAt, outLength)
  return {
    x,
    out,
    run(r0, r1, isMasked) {
      out.fill(0, 0, isMasked ? out.length : BAND * held)
      for (let k0 = 0; k0 < ld; k0 += K_BLOCK) {
        const k1 = Math.min(ld, k0 + K_BLOCK)
        for (let b0 = r0; b0 < held; b0 += B_BLOCK) {
          const b1 = Math.min(held, b0 + B_BLOCK)
          if (isMasked) masked(0, ld, outAt, held, BAND * held, r0, r0, r1, b0, b1, k0, k1)
          else gram(0, 0, ld, outAt, held, r0, r0, r1, b0, b1, k0, k1)
        }
      }
    },
  }
}

function jsEngine(ld: number, held: number): RowsEngine {
  const x = new Float32Array(held * ld)
  const out = new Float64Array(6 * BAND * held)
  return {
    x,
    out,
    run(r0, r1, isMasked) {
      out.fill(0, 0, isMasked ? out.length : BAND * held)
      for (let k0 = 0; k0 < ld; k0 += K_BLOCK) {
        const k1 = Math.min(ld, k0 + K_BLOCK)
        for (let b0 = r0; b0 < held; b0 += B_BLOCK) {
          const b1 = Math.min(held, b0 + B_BLOCK)
          if (isMasked) gramMaskedJs(x, ld, out, held, BAND * held, r0, r0, r1, b0, b1, k0, k1)
          else gramJs(x, ld, out, held, r0, r0, r1, b0, b1, k0, k1)
        }
      }
    },
  }
}

/**
 * `gram.c`'s `gram`, in JavaScript: the fallback where the module cannot load,
 * and the reference the tests hold the kernel to. Two rows against two, so the
 * four sums stay in registers and each load feeds two of them.
 */
function gramJs(
  x: Float32Array,
  ld: number,
  out: Float64Array,
  ldg: number,
  g0: number,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  k0: number,
  k1: number,
): void {
  for (let a = a0; a < a1; a += 2) {
    const ar = a + 1 < a1 ? a + 1 : a
    const pa0 = a * ld
    const pa1 = ar * ld
    const o0 = (a - g0) * ldg
    const o1 = (ar - g0) * ldg
    for (let b = Math.max(a, b0); b < b1; b += 2) {
      const br = b + 1 < b1 ? b + 1 : b
      const pb0 = b * ld
      const pb1 = br * ld
      let s00 = 0
      let s01 = 0
      let s10 = 0
      let s11 = 0
      for (let k = k0; k < k1; k++) {
        const u0 = x[pa0 + k]
        const u1 = x[pa1 + k]
        const v0 = x[pb0 + k]
        const v1 = x[pb1 + k]
        s00 += u0 * v0
        s01 += u0 * v1
        s10 += u1 * v0
        s11 += u1 * v1
      }
      out[o0 + b] += s00
      if (br !== b) out[o0 + br] += s01
      if (ar !== a) {
        out[o1 + b] += s10
        if (br !== b) out[o1 + br] += s11
      }
    }
  }
}

/** `gram.c`'s `gram_masked`, in JavaScript, for the same two reasons. */
function gramMaskedJs(
  x: Float32Array,
  ld: number,
  out: Float64Array,
  ldg: number,
  size: number,
  g0: number,
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  k0: number,
  k1: number,
): void {
  for (let a = a0; a < a1; a++) {
    const pa = a * ld
    const o = (a - g0) * ldg
    for (let b = Math.max(a, b0); b < b1; b++) {
      const pb = b * ld
      let p = 0
      let n = 0
      let sa = 0
      let sb = 0
      let qa = 0
      let qb = 0
      for (let k = k0; k < k1; k++) {
        const u = x[pa + k]
        const v = x[pb + k]
        if (u !== u || v !== v) continue
        p += u * v
        n++
        sa += u
        sb += v
        qa += u * u
        qb += v * v
      }
      out[o + b] += p
      out[size + o + b] += n
      out[2 * size + o + b] += sa
      out[3 * size + o + b] += sb
      out[4 * size + o + b] += qa
      out[5 * size + o + b] += qb
    }
  }
}
