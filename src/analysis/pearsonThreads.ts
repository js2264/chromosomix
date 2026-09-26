/**
 * The correlation matrix on several threads (§18.6).
 *
 * `pearsonRows.ts` does the arithmetic in bands of rows, each band's rows against
 * every row after them; nothing a band computes depends on another band. So the
 * square is read once, on the thread that was asked, and the bands are shared
 * out: that thread keeps the first, and each helper worker (`worker/gram.worker.ts`)
 * is sent a contiguous stretch of the rest, with only the rows its stretch reads
 * — its own and every row after them — and sends each band's lines back as it
 * finishes. Measured in Chromium with four cores, the product runs at over three
 * times one core's pace: it is blocked for the caches, so the cores do not wait
 * on memory, and what is left is the square read and copied out beforehand.
 *
 * **The stretches are equal work, not equal rows.** Row `a` is correlated with
 * the `m − a` rows after it, so the first rows cost the most; the boundaries are
 * where the triangle's area divides evenly — the first stretch a little short of
 * an equal share, since the thread that keeps it also writes out every line. It
 * is the thread that read the square, and the first stretch reads every row —
 * it has them all — while a helper's copy is of the rows from its stretch on, so
 * the helpers late in the square are sent the least.
 *
 * **Copies, and how many.** Without shared memory — the app is not served with
 * the headers `SharedArrayBuffer` needs — each helper's rows are a copy, so the
 * number of helpers is chosen within {@link COPY_BUDGET}: at 4,096 bins three
 * helpers cost 130 MB of copies, at 8,192 the budget allows one.
 *
 * **The helpers are kept.** Starting one is a module to load and a kernel to
 * compile — a third of a second, measured, which at 4,096 bins was a fifth of
 * the whole job spent with the helpers not yet working and this thread waiting
 * for them at the end. So a helper that finished its stretch is kept for the
 * next square, for a minute, and they are asked for before the square is read
 * rather than after, so the first ones start while it is. A job's messages
 * carry its number, so one from a finished job can never be read as the next's.
 *
 * **Nothing depends on the helpers.** A helper that cannot be started, or that
 * fails, has its bands computed here instead, from the rows this thread still
 * holds; the answer is the same, only later. And the lines are handed over in
 * row order whatever order they arrive in, with `onRow` asked before each —
 * which is where progress is reported and a cancel is heard, and where a throw
 * stops the helpers still working: they are terminated, and never kept.
 */

import {
  BAND,
  correlateBand,
  makeEngine,
  pearsonRows,
  readSquare,
  strideOf,
  type PearsonInput,
  type PearsonOutput,
  type PreparedRows,
} from './pearsonRows'

/** What a helper is sent: its stretch of rows, and every row it reads. */
export interface GramJob {
  /** Which job this is, echoed on every message it sends back. */
  id: number
  /** The square's side, and the floats between rows. */
  m: number
  ld: number
  /** The first row of the stretch, and of the rows sent: `[first, m)`. */
  first: number
  /** The end of the stretch: the helper correlates rows `[first, to)`. */
  to: number
  masked: boolean
  /** Rows `[first, m)`, `ld` floats each, in the form `masked` says. */
  x: Float32Array
  /** Their totals and missing columns, as `PreparedRows` holds them, counted from `first`. */
  count: Float64Array
  sum: Float64Array
  squares: Float64Array
  starts: Int32Array
  cols: Int32Array
}

/** What a helper sends back. */
export type GramMessage =
  | {
      kind: 'band'
      id: number
      r0: number
      r1: number
      /** Row `a`'s line is at `(a − r0) · m`; only its cells after `a` mean anything. */
      lines: Float32Array
    }
  | { kind: 'done'; id: number }
  | { kind: 'error'; id: number; message: string }

/**
 * The most the helpers' copies of the rows may add up to. Each is the rows from
 * its stretch on, as floats; at 4,096 bins the square is 64 MB of them.
 */
const COPY_BUDGET = 384 * 1024 * 1024

/** Squares below this many rows are done on one thread: at 1,000 bins that is a tenth of a second. */
const THREAD_FROM = 1024

/**
 * The work the thread that asked keeps, as a fraction of a helper's: besides its
 * own stretch it copies the helpers' rows out to them first and writes every
 * line of the matrix as it arrives, which is a tenth of a stretch at 4,096 bins.
 */
const OWN_SHARE = 0.9

/** How long a helper with nothing to do is kept for the next square. */
const KEEP_MS = 60_000

/** How helpers are started, how many there may be, and the ones kept; `null` for one thread. */
interface Threads {
  spawn: () => Worker
  helpers: number
  /** Helpers that finished a stretch, ready for the next square. */
  idle: Worker[]
  /** When the idle ones are let go. */
  release: ReturnType<typeof setTimeout> | null
}

let threads: Threads | null = null
let nextJob = 1

/**
 * Let the correlation use helper workers — called once, by the analysis worker,
 * which is where the correlation runs in the app. Anywhere it is not called —
 * the tests, the command line — the correlation stays on its own thread.
 * Called again, it lets the helpers it kept go.
 */
export function useCorrelationThreads(spawn: () => Worker, helpers: number): void {
  if (threads !== null) letGo(threads)
  threads = helpers > 0 ? { spawn, helpers, idle: [], release: null } : null
}

/** A kept helper, or a new one; `null` where none can be started here. */
function take(pool: Threads): Worker | null {
  const kept = pool.idle.pop()
  if (kept !== undefined) return kept
  try {
    return pool.spawn()
  } catch {
    return null
  }
}

/** Keep a helper that finished its stretch, and let the kept ones go a while after the last square. */
function keep(pool: Threads, helper: Worker): void {
  helper.onmessage = null
  helper.onerror = null
  pool.idle.push(helper)
}

function letGo(pool: Threads): void {
  if (pool.release !== null) clearTimeout(pool.release)
  pool.release = null
  for (const helper of pool.idle.splice(0)) helper.terminate()
}

function letGoLater(pool: Threads): void {
  if (pool.release !== null) clearTimeout(pool.release)
  pool.release = null
  if (pool.idle.length === 0) return
  pool.release = setTimeout(() => {
    pool.release = null
    letGo(pool)
  }, KEEP_MS)
  // Not what keeps a process alive where there is one to keep (the tests).
  ;(pool.release as { unref?: () => void }).unref?.()
}

/**
 * Correlate every pair of rows, on as many threads as are allowed and worth it.
 *
 * The same contract as `pearsonRows`: `output` is handed each row's line in
 * order, and `onRow` is asked before each and awaited.
 */
export async function pearsonRowsThreaded(
  input: PearsonInput,
  output: PearsonOutput,
  onRow?: (row: number) => void | Promise<void>,
): Promise<void> {
  const m = input.m
  const pool = threads
  if (pool === null || m < THREAD_FROM) return pearsonRows(input, output, onRow)

  // The helpers first, so any that have to be started load while the square is
  // read. As many as the stretches the square will be shared into.
  const stretches = stretchesFor(m, strideOf(m), pool.helpers)
  if (pool.release !== null) clearTimeout(pool.release)
  pool.release = null
  const helpers: { worker: Worker | null; from: number; to: number; delivered: boolean; failed: boolean }[] = []
  for (let t = 1; t < stretches.length - 1; t++) {
    helpers.push({ worker: take(pool), from: stretches[t], to: stretches[t + 1], delivered: false, failed: false })
  }

  const line = new Float64Array(m)
  // Each band a helper owes, by its first row: the lines once they arrive, or
  // `null` once its helper is gone and it has to be computed here.
  const owed = new Map<number, { settle: (lines: Float32Array | null) => void; lines: Promise<Float32Array | null> }>()
  const oweBand = (r0: number): void => {
    let settle!: (lines: Float32Array | null) => void
    const lines = new Promise<Float32Array | null>((resolve) => {
      settle = resolve
    })
    owed.set(r0, { settle, lines })
  }

  try {
    const { engine, rows } = readSquare(input)
    for (const helper of helpers) {
      const { worker, from, to } = helper
      for (let r0 = from; r0 < to; r0 += BAND) oweBand(r0)
      const failed = (): void => {
        // Whatever this helper had not sent is computed here, and it is not kept.
        helper.failed = true
        for (let r0 = from; r0 < to; r0 += BAND) owed.get(r0)?.settle(null)
      }
      if (worker === null) {
        failed()
        continue
      }
      const id = nextJob++
      // The last band's first row: once it is in, the helper has sent everything.
      const last = from + Math.floor((to - 1 - from) / BAND) * BAND
      worker.onmessage = (event: MessageEvent<GramMessage>) => {
        const message = event.data
        if (message.id !== id) return
        if (message.kind === 'band') {
          owed.get(message.r0)?.settle(message.lines)
          if (message.r0 === last) helper.delivered = true
        } else if (message.kind === 'error') failed()
      }
      worker.onerror = (event) => {
        event.preventDefault()
        failed()
      }
      const job = jobFor(id, engine.x, rows, from, to)
      worker.postMessage(job, [job.x.buffer, job.count.buffer, job.sum.buffer, job.squares.buffer, job.starts.buffer, job.cols.buffer])
    }

    for (let r0 = 0; r0 < m; r0 += BAND) {
      const r1 = Math.min(m, r0 + BAND)
      const due = owed.get(r0)
      const lines = due === undefined ? null : await due.lines
      if (lines === null) {
        // This thread's own stretch, or a band whose helper is gone.
        if (onRow !== undefined) {
          for (let r = r0; r < r1; r++) {
            const waiting = onRow(r)
            if (waiting !== undefined) await waiting
          }
        }
        correlateBand(engine, rows, r0, r1, line, output)
        continue
      }
      for (let a = r0; a < r1; a++) {
        if (onRow !== undefined) {
          const waiting = onRow(a)
          if (waiting !== undefined) await waiting
        }
        const at = (a - r0) * m
        for (let b = a + 1; b < m; b++) line[b] = lines[at + b]
        output(a, line)
      }
    }
  } finally {
    // One that sent every band is idle and is kept; one still working — the
    // caller stopped, or this thread failed — or one that failed is let go.
    for (const { worker, delivered, failed } of helpers) {
      if (worker === null) continue
      if (delivered && !failed) keep(pool, worker)
      else worker.terminate()
    }
    letGoLater(pool)
  }
}

/**
 * A helper's whole job: correlate its stretch a band at a time, with the same
 * arithmetic the thread that asked would have used, and send each band's lines
 * as soon as it has them — as floats, which is all the precision the kernel
 * gives, and half the bytes. Here rather than in `worker/gram.worker.ts` so the
 * tests can run it without a worker.
 */
export function runGramJob(job: GramJob, send: (message: GramMessage, transfer?: Transferable[]) => void): void {
  const { id } = job
  try {
    const { m, ld, first, to } = job
    const engine = makeEngine('wasm', ld, m - first)
    engine.x.set(job.x)
    const rows: PreparedRows = {
      m,
      ld,
      first,
      masked: job.masked,
      count: job.count,
      sum: job.sum,
      squares: job.squares,
      starts: job.starts,
      cols: job.cols,
    }
    const line = new Float64Array(m)
    for (let r0 = first; r0 < to; r0 += BAND) {
      const r1 = Math.min(to, r0 + BAND)
      const lines = new Float32Array((r1 - r0) * m)
      correlateBand(engine, rows, r0, r1, line, (a, done) => {
        const at = (a - r0) * m
        for (let b = a + 1; b < m; b++) lines[at + b] = done[b]
      })
      send({ kind: 'band', id, r0, r1, lines }, [lines.buffer])
    }
    send({ kind: 'done', id })
  } catch (err) {
    send({ kind: 'error', id, message: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Where the stretches start: row 0, then each boundary, then `m` — as many
 * helpers as are allowed and as the copies fit, the boundaries on whole bands
 * and where the triangle's area divides evenly, less the {@link OWN_SHARE} the
 * first stretch gives up. Below {@link THREAD_FROM}, or where no helper's copy
 * fits, one stretch.
 */
export function stretchesFor(m: number, ld: number, helpers: number): number[] {
  for (let parts = helpers + 1; parts > 1; parts--) {
    const edges = [0]
    const whole = OWN_SHARE + parts - 1
    for (let t = 1; t < parts; t++) {
      // The rows before `s` carry `1 − (1 − s/m)²` of the triangle's area.
      const share = (OWN_SHARE + t - 1) / whole
      const s = Math.round((m * (1 - Math.sqrt(1 - share))) / BAND) * BAND
      if (s > edges[edges.length - 1] && s < m) edges.push(s)
    }
    edges.push(m)
    let copies = 0
    for (let t = 1; t < edges.length - 1; t++) copies += (m - edges[t]) * ld * 4
    if (edges.length > 2 && copies <= COPY_BUDGET) return edges
  }
  return [0, m]
}

/** The rows `[from, m)` and their totals, copied for a helper that will correlate `[from, to)`. */
function jobFor(id: number, x: Float32Array, rows: PreparedRows, from: number, to: number): GramJob {
  const { m, ld } = rows
  const held = m - from
  const starts = new Int32Array(held + 1)
  const base = rows.starts[from]
  for (let i = 0; i <= held; i++) starts[i] = rows.starts[from + i] - base
  return {
    id,
    m,
    ld,
    first: from,
    to,
    masked: rows.masked,
    x: x.slice(from * ld, m * ld),
    count: rows.count.slice(from, m),
    sum: rows.sum.slice(from, m),
    squares: rows.squares.slice(from, m),
    starts,
    cols: rows.cols.slice(base, rows.starts[m]),
  }
}
