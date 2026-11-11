/**
 * pastis-NB's fit on several threads (§25.6): its MDS start and its likelihood.
 *
 * Every step of *Model from the map*'s pastis-NB fit is a line search, and
 * every point it tries is one evaluation of an objective over every pair of
 * beads — pastis' relative stress for the MDS start, a few nanoseconds a pair,
 * then the likelihood, four logarithms and exponentials a pair and a hundred
 * and fifty nanoseconds. At 905 beads a likelihood is sixty milliseconds; at
 * twelve thousand it is ten seconds, a hundred and fifty times over. The pairs
 * are independent of each other, so the pass is shared out: each objective is
 * already a sum over **bands** of rows (`structure/negbinom.ts`'s
 * `mdsBands` and `likelihoodBands`), and the bands go to helper workers, a
 * contiguous stretch each, while this thread computes a stretch of its own.
 *
 * **The same bits, on any number of threads.** A band's value and its partial
 * gradient are computed whole, by the one function, wherever the band is; the
 * layout is a function of the bead count alone; and the bands are added here
 * in band order, as `mdsObjective` and `negBinomObjective` add them on one
 * thread. So a fit is the same model on one thread and on eight, on a machine
 * with two cores and on one with sixteen — which is the property a
 * reproducible model needs and a thread pool does not give for free:
 * floating-point addition is not associative, and a sum that grouped the bands
 * by thread would round differently on every machine.
 *
 * **What crosses.** The app is not served with the headers `SharedArrayBuffer`
 * needs, so a helper is sent a **copy**, once per objective: the MDS's wishes
 * below the diagonal of its own rows, then the likelihood's counts above it,
 * packed row after row — a triangle and not the square, so the copies together
 * are at most half a matrix, and a helper holds one objective's at a time —
 * and, for the likelihood, the biases. Then, per evaluation, the coordinates,
 * and back come its bands' values and partial gradients, whose buffers are
 * *transferred* there and back so that nothing is allocated per evaluation. The
 * copies are held to {@link COPY_BUDGET}, and fewer helpers are used where they
 * would not fit. Where the matrix is on a `SharedArrayBuffer` — the command
 * line allocates it there, Node having no headers to ask for — nothing is
 * copied at all: every helper reads the one matrix, and the budget does not
 * bind.
 *
 * **Nothing depends on the helpers.** One that cannot be started, or that fails
 * at any point, has its bands computed here instead, from the whole matrix this
 * thread still holds — the same function, so the same numbers, only later. So
 * does one that has not said it is up yet: a helper takes a tenth of a second
 * or so to start, which at a thousand beads is most of the MDS, and the first
 * evaluations do not wait for it. A stop, or the end of the fit, terminates every helper ({@link FitThreads.close}):
 * a model is not something run a hundred times a minute, so they are started
 * afresh each time rather than kept holding a copy of a map nobody is fitting.
 *
 * Where helpers come from is the caller's to say ({@link useLikelihoodThreads}):
 * the analysis worker starts them as web workers (`worker/likelihood.worker.ts`),
 * the command line as Node worker threads (`cli/threads.ts`), and the tests as
 * in-process stand-ins. Anywhere it is not called the fit runs on one thread —
 * the same numbers, one thread's time. The command line calls it only when
 * asked to, with `--threads`.
 */

import {
  addBand,
  likelihoodBand,
  likelihoodBands,
  likelihoodTerms,
  mdsBand,
  mdsBands,
  type Dispersion,
  type LikelihoodTerms,
  type NegBinomModel,
} from '../structure/negbinom'
import type { DenseMatrix } from '../structure/reconstruct'

/** Which of pastis-NB's two objectives a helper is computing bands of. */
export type FitObjective = 'mds' | 'likelihood'

/** What a helper is sent once per objective, before its first evaluation. */
export interface LikelihoodSetup {
  kind: 'setup'
  id: number
  objective: FitObjective
  n: number
  /** The likelihood's: unread by the MDS. */
  alpha: number
  bias: Float64Array | null
  dispersion: Dispersion | null
  /** Its bands' edges, in rows: band `k` is `[edges[k], edges[k + 1])`. */
  edges: number[]
  /**
   * Its rows of the matrix, packed row after row: for the MDS the wishes below
   * the diagonal, row `i` holding `i`; for the likelihood the counts above it,
   * row `i` holding `n − 1 − i`. Or, where `shared`, the whole `n × n` matrix
   * itself, on memory every thread can read.
   */
  values: Float32Array | Float64Array
  shared: boolean
}

/** What a helper is sent per evaluation: the point, and its bands' buffers back to write into. */
export interface LikelihoodEvaluate {
  kind: 'evaluate'
  id: number
  seq: number
  point: Float64Array
  parts: Float64Array[]
}

export type LikelihoodRequest = LikelihoodSetup | LikelihoodEvaluate

/** What a helper sends back: that it is up, once, and then its shares. */
export type LikelihoodMessage =
  | { kind: 'ready' }
  | { kind: 'shares'; id: number; seq: number; values: number[]; parts: Float64Array[] }
  | { kind: 'error'; id: number; message: string }

type Shares = Extract<LikelihoodMessage, { kind: 'shares' }>

/**
 * The most the helpers' copies of one objective's matrix may add up to. At
 * twelve thousand beads a triangle is 288 MB of singles, and with three helpers
 * they hold about three-quarters of it.
 */
const COPY_BUDGET = 512 * 1024 * 1024

/** Bead counts below this are fitted on one thread: at 256 beads a likelihood is five milliseconds. */
const THREAD_FROM = 256

/**
 * The work this thread keeps, as a fraction of a helper's: besides its own
 * bands it sends the point out and adds every band's gradient in, which at a
 * thousand beads is a twentieth of a band.
 */
const OWN_SHARE = 0.9

/** How helpers are started and how many there may be; `null` for one thread. */
interface Threads {
  spawn: () => Worker
  helpers: number
}

let threads: Threads | null = null
let nextJob = 1

/**
 * Let pastis-NB's fit use helper workers — called once, by whatever runs the
 * analysis: the analysis worker in the app, `main` on the command line.
 * `helpers` is how many besides the calling thread; `0` is one thread.
 */
export function useLikelihoodThreads(spawn: () => Worker, helpers: number): void {
  threads = helpers > 0 ? { spawn, helpers: Math.floor(helpers) } : null
}

/** One objective's evaluations, wherever they are computed. */
export interface FitEvaluator {
  /** Threads computing its bands, this one included, as it was opened. */
  readonly threads: number
  /** The objective at `point`, its gradient written into `gradient`. */
  evaluate(point: Float64Array, gradient: Float64Array): Promise<number>
}

/** The helpers of one fit, lent to its MDS start and then to its likelihood. */
export interface FitThreads {
  /** Threads started for the fit, this one included. */
  readonly threads: number
  /** pastis' MDS on `wishes`, the matrix `storeWishes` wrote below the diagonal of. */
  mds(wishes: DenseMatrix): FitEvaluator
  /** The likelihood of `model`; the MDS's evaluations end here. */
  likelihood(model: NegBinomModel): FitEvaluator
  /** Terminate every helper. Called once the fit ends, or stops. */
  close(): void
}

interface Helper {
  worker: Worker
  alive: boolean
  /** Whether it has said it is up; until then its bands are computed here. */
  ready: boolean
  /** The evaluation it owes, resolved with its answer — or with `null` once it has failed. */
  owed: { id: number; seq: number; resolve: (answer: Shares | null) => void } | null
}

/**
 * Start the helpers for a fit of `n` beads whose matrix is `matrix`: as many as
 * are allowed, worth it, and fit in the copy budget. Each objective is then
 * opened on them in turn, its bands shared between this thread and the
 * helpers still alive.
 */
export function openFitThreads(n: number, matrix: DenseMatrix): FitThreads {
  const pool = threads
  const bytesOf = (values: DenseMatrix): number => (isShared(values) ? 0 : values.BYTES_PER_ELEMENT)
  const wanted =
    pool === null || n < THREAD_FROM ? 0 : shareBands(likelihoodBands(n), n, pool.helpers, bytesOf(matrix)).length - 2

  const helpers: Helper[] = []
  for (let t = 0; pool !== null && t < wanted; t++) {
    let worker: Worker
    try {
      worker = pool.spawn()
    } catch {
      // None can be started here: the bands are this thread's.
      continue
    }
    const helper: Helper = { worker, alive: true, ready: false, owed: null }
    worker.onmessage = (event: MessageEvent<LikelihoodMessage>) => {
      const message = event.data
      if (message.kind === 'ready') {
        helper.ready = true
        return
      }
      if (message.kind === 'error') {
        failed(helper)
        return
      }
      const owed = helper.owed
      if (owed === null || message.id !== owed.id || message.seq !== owed.seq) return
      helper.owed = null
      owed.resolve(message)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      failed(helper)
    }
    helpers.push(helper)
  }

  const open = (objective: FitObjective, model: NegBinomModel): FitEvaluator => {
    const values = model.counts
    const shared = isShared(values)
    const mds = objective === 'mds'
    const terms = mds ? null : likelihoodTerms(model)
    const edges = mds ? mdsBands(n) : likelihoodBands(n)
    const bands = edges.length - 1
    // Where band `b`'s gradient starts, and how many beads it holds.
    const from = (b: number): number => (mds ? 0 : edges[b])
    const length = (b: number): number => (mds ? edges[b + 1] : n - edges[b])
    const parts: Float64Array[] = Array.from({ length: bands }, (_, b) => new Float64Array(3 * length(b)))
    const sums = new Float64Array(bands)
    const id = nextJob++
    let seq = 0

    // The objective before this one is over: whatever it is still owed is not coming.
    for (const helper of helpers) {
      const owed = helper.owed
      helper.owed = null
      owed?.resolve(null)
    }
    const alive = helpers.filter((helper) => helper.alive)
    const plan = alive.length === 0 ? [0, bands] : shareBands(edges, n, alive.length, bytesOf(values), objective)
    const working: Array<{ helper: Helper; from: number; to: number }> = []
    for (let t = 1; t + 1 < plan.length; t++) {
      const helper = alive[t - 1]
      try {
        const setup = setupFor(id, objective, model, edges, plan[t], plan[t + 1], shared)
        helper.worker.postMessage(setup, shared ? [] : [setup.values.buffer as ArrayBuffer])
      } catch {
        failed(helper)
      }
      working.push({ helper, from: plan[t], to: plan[t + 1] })
    }

    const compute = (b: number, point: Float64Array): void => {
      // A buffer lent to a helper that then failed went with it.
      if (parts[b].length === 0) parts[b] = new Float64Array(3 * length(b))
      sums[b] =
        terms === null
          ? mdsBand(values, null, n, edges[b], edges[b + 1], point, parts[b])
          : likelihoodBand(terms, values, null, edges[b], edges[b + 1], point, parts[b])
    }

    return {
      threads: 1 + working.filter(({ helper }) => helper.alive).length,
      async evaluate(point, gradient) {
        seq++
        const answers = working.map(({ helper, from: b0, to: b1 }) => {
          if (!helper.alive || !helper.ready) return Promise.resolve(null)
          return new Promise<Shares | null>((resolve) => {
            helper.owed = { id, seq, resolve }
            const lent: Float64Array[] = []
            for (let b = b0; b < b1; b++) {
              if (parts[b].length === 0) parts[b] = new Float64Array(3 * length(b))
              lent.push(parts[b])
            }
            const request: LikelihoodEvaluate = { kind: 'evaluate', id, seq, point, parts: lent }
            try {
              helper.worker.postMessage(request, lent.map((part) => part.buffer))
            } catch {
              failed(helper)
            }
          })
        })
        for (let b = 0; b < plan[1]; b++) compute(b, point)
        const answered = await Promise.all(answers)
        working.forEach(({ from: b0, to: b1 }, at) => {
          const answer = answered[at]
          for (let b = b0; b < b1; b++) {
            if (answer === null) {
              compute(b, point)
              continue
            }
            sums[b] = answer.values[b - b0]
            parts[b] = answer.parts[b - b0]
          }
        })

        // In band order, as one thread adds them (`mdsObjective`, `negBinomObjective`).
        gradient.fill(0)
        let value = 0
        for (let b = 0; b < bands; b++) {
          const share = sums[b]
          if (!mds && !Number.isFinite(share)) return Number.POSITIVE_INFINITY
          value += share
          addBand(gradient, parts[b], n, from(b), length(b))
        }
        return mds || Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
      },
    }
  }

  return {
    threads: 1 + helpers.length,
    mds: (wishes) => open('mds', { counts: wishes, n, alpha: 1, bias: null, dispersion: null }),
    likelihood: (model) => open('likelihood', model),
    close() {
      for (const helper of helpers) failed(helper)
    },
  }
}

/** Let a helper go: terminated, and whatever it owed computed here instead. */
function failed(helper: Helper): void {
  if (!helper.alive) return
  helper.alive = false
  helper.worker.onmessage = null
  helper.worker.onerror = null
  helper.worker.terminate()
  const owed = helper.owed
  helper.owed = null
  owed?.resolve(null)
}

/** Whether `matrix` is on memory other threads can read. */
function isShared(matrix: DenseMatrix): boolean {
  return typeof SharedArrayBuffer === 'function' && matrix.buffer instanceof SharedArrayBuffer
}

/**
 * Which bands each thread computes, as indices into the layout: `[0, k₁, …, bands]`,
 * this thread's stretch first and a helper's each after it — as many helpers as
 * are allowed and as there are bands to give them, their stretches equal in
 * work (the bands are), this thread's {@link OWN_SHARE} of one, and fewer
 * helpers where their copies would not fit in {@link COPY_BUDGET}.
 */
export function shareBands(
  edges: Int32Array,
  n: number,
  helpers: number,
  bytes: number,
  objective: FitObjective = 'likelihood',
): number[] {
  const bands = edges.length - 1
  for (let parts = Math.min(helpers + 1, bands); parts > 1; parts--) {
    const whole = OWN_SHARE + parts - 1
    const plan = [0]
    for (let t = 1; t < parts; t++) {
      const cut = Math.round((bands * (OWN_SHARE + t - 1)) / whole)
      if (cut > plan[plan.length - 1] && cut < bands) plan.push(cut)
    }
    plan.push(bands)
    let copies = 0
    for (let t = 1; t + 1 < plan.length; t++) copies += pairsIn(objective, edges[plan[t]], edges[plan[t + 1]], n) * bytes
    if (plan.length > 2 && copies <= COPY_BUDGET) return plan
  }
  return [0, bands]
}

/** Pairs in rows `[r0, r1)`: below the diagonal for the MDS, above it for the likelihood. */
function pairsIn(objective: FitObjective, r0: number, r1: number, n: number): number {
  let pairs = 0
  for (let i = r0; i < r1; i++) pairs += objective === 'mds' ? i : n - 1 - i
  return pairs
}

/**
 * A helper's setup: its bands' edges, and its rows of the matrix on the side
 * its objective reads, packed — or the shared matrix itself, which costs
 * nothing to send.
 */
function setupFor(
  id: number,
  objective: FitObjective,
  model: NegBinomModel,
  edges: Int32Array,
  from: number,
  to: number,
  shared: boolean,
): LikelihoodSetup {
  const { n, counts } = model
  const r0 = edges[from]
  const r1 = edges[to]
  let sent = counts
  if (!shared) {
    // The matrix's own kind of float, so a helper reads the very numbers this thread would.
    const packed = new (counts instanceof Float64Array ? Float64Array : Float32Array)(pairsIn(objective, r0, r1, n))
    let at = 0
    for (let i = r0; i < r1; i++) {
      const row = objective === 'mds' ? counts.subarray(i * n, i * n + i) : counts.subarray(i * n + i + 1, (i + 1) * n)
      packed.set(row, at)
      at += row.length
    }
    sent = packed
  }
  return {
    kind: 'setup',
    id,
    objective,
    n,
    alpha: model.alpha,
    bias: model.bias ?? null,
    dispersion: model.dispersion,
    edges: Array.from(edges.subarray(from, to + 1)),
    values: sent,
    shared,
  }
}

/**
 * A helper: what it holds between evaluations, and what it does with each
 * message. Here rather than in `worker/likelihood.worker.ts` so that the tests,
 * and the command line's worker threads, run the same code a web worker does.
 * A setup replaces whatever it held, so it holds one objective's rows at a time.
 * It says it is up as it is made.
 */
export function likelihoodHelper(
  send: (message: LikelihoodMessage, transfer?: Transferable[]) => void,
): (request: LikelihoodRequest) => void {
  send({ kind: 'ready' })
  let held: {
    id: number
    n: number
    /** `null` for the MDS. */
    terms: LikelihoodTerms | null
    values: DenseMatrix
    edges: number[]
    /** Where each row of each band starts in `values`, less its first column: `offset + j`. */
    offsets: Float64Array[]
  } | null = null
  return (request) => {
    try {
      if (request.kind === 'setup') {
        held = null
        const { n, edges, shared, objective } = request
        const mds = objective === 'mds'
        const offsets: Float64Array[] = []
        let start = 0
        for (let k = 0; k + 1 < edges.length; k++) {
          const rows = new Float64Array(edges[k + 1] - edges[k])
          for (let i = edges[k]; i < edges[k + 1]; i++) {
            // Row `i` of the whole matrix starts at `i·n`; of the packed copy,
            // after the rows before it — for the likelihood, at its first
            // column past the diagonal.
            if (mds) {
              rows[i - edges[k]] = shared ? i * n : start
              start += i
            } else {
              rows[i - edges[k]] = shared ? i * n : start - i - 1
              start += n - 1 - i
            }
          }
          offsets.push(rows)
        }
        held = { id: request.id, n, terms: mds ? null : likelihoodTerms(request), values: request.values, edges, offsets }
        return
      }
      if (held === null || held.id !== request.id) throw new Error('an evaluation before its setup')
      const { n, terms, values: matrix, edges, offsets } = held
      const values: number[] = []
      const parts: Float64Array[] = []
      for (let k = 0; k + 1 < edges.length; k++) {
        const size = 3 * (terms === null ? edges[k + 1] : n - edges[k])
        const given = request.parts[k]
        const part = given !== undefined && given.length === size ? given : new Float64Array(size)
        values.push(
          terms === null
            ? mdsBand(matrix, offsets[k], n, edges[k], edges[k + 1], request.point, part)
            : likelihoodBand(terms, matrix, offsets[k], edges[k], edges[k + 1], request.point, part),
        )
        parts.push(part)
      }
      send({ kind: 'shares', id: request.id, seq: request.seq, values, parts }, parts.map((part) => part.buffer))
    } catch (err) {
      send({ kind: 'error', id: request.id, message: err instanceof Error ? err.message : String(err) })
    }
  }
}
