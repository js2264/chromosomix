/**
 * pastis-NB's likelihood on several threads (§25.6).
 *
 * Every step of *Model from the map*'s pastis-NB fit is a line search, and
 * every point it tries is one evaluation of the likelihood: a pass over every
 * pair of beads, four logarithms and exponentials a pair, a hundred and fifty
 * nanoseconds on one core. At 905 beads that is sixty milliseconds; at twelve
 * thousand it is ten seconds, a hundred and fifty times over. The pairs are
 * independent of each other, so the pass is shared out: the likelihood is
 * already a sum over **bands** of rows (`structure/negbinom.ts`'s
 * `likelihoodBands`), and the bands go to helper workers, a contiguous stretch
 * each, while this thread computes a stretch of its own.
 *
 * **The same bits, on any number of threads.** A band's value and its partial
 * gradient are computed whole, by the one function, wherever the band is; the
 * layout is a function of the bead count alone; and the bands are added here
 * in band order, as `negBinomObjective` adds them on one thread. So a fit is
 * the same model on one thread and on eight, on a machine with two cores and
 * on one with sixteen — which is the property a reproducible model needs and a
 * thread pool does not give for free: floating-point addition is not
 * associative, and a sum that grouped the bands by thread would round
 * differently on every machine.
 *
 * **What crosses.** The app is not served with the headers `SharedArrayBuffer`
 * needs, so a helper is sent a **copy**: once, at the start, the counts above
 * the diagonal of its own rows, packed row after row — the triangle and not the
 * square, so the copies together are at most half a matrix — and the biases.
 * Then, per evaluation, the coordinates, and back come its bands' values and
 * partial gradients, whose buffers are *transferred* there and back so that
 * nothing is allocated per evaluation. The copies are held to
 * {@link COPY_BUDGET}, and fewer helpers are used where they would not fit.
 * Where the counts are on a `SharedArrayBuffer` — the command line allocates
 * them there, Node having no headers to ask for — nothing is copied at all:
 * every helper reads the one matrix, and the budget does not bind.
 *
 * **Nothing depends on the helpers.** One that cannot be started, or that fails
 * at any point, has its bands computed here instead, from the whole matrix this
 * thread still holds — the same function, so the same numbers, only later. A
 * stop, or the end of the fit, terminates every helper ({@link
 * LikelihoodEvaluator.close}): a model is not something run a hundred times a
 * minute, so they are started afresh each time — in the time the MDS start
 * takes — rather than kept holding a copy of a map nobody is fitting.
 *
 * Where helpers come from is the caller's to say ({@link useLikelihoodThreads}):
 * the analysis worker starts them as web workers (`worker/likelihood.worker.ts`),
 * the command line as Node worker threads (`cli/threads.ts`), and the tests as
 * in-process stand-ins. Anywhere it is not called the likelihood runs on one
 * thread — the same numbers, one thread's time.
 */

import {
  addBand,
  likelihoodBand,
  likelihoodBands,
  likelihoodTerms,
  type Dispersion,
  type LikelihoodTerms,
  type NegBinomModel,
} from '../structure/negbinom'
import type { DenseMatrix } from '../structure/reconstruct'

/** What a helper is sent once, at the start of a fit. */
export interface LikelihoodSetup {
  kind: 'setup'
  id: number
  n: number
  alpha: number
  bias: Float64Array | null
  dispersion: Dispersion | null
  /** Its bands' edges, in rows: band `k` is `[edges[k], edges[k + 1])`. */
  edges: number[]
  /**
   * The counts of its rows above the diagonal, row after row: row `i` holds
   * `n − 1 − i`. Or, where `shared`, the whole `n × n` matrix itself, on
   * memory every thread can read.
   */
  counts: Float32Array | Float64Array
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

/** What a helper sends back. */
export type LikelihoodMessage =
  | { kind: 'shares'; id: number; seq: number; values: number[]; parts: Float64Array[] }
  | { kind: 'error'; id: number; message: string }

/**
 * The most the helpers' copies of the counts may add up to. At twelve thousand
 * beads the triangle is 288 MB of singles, and with three helpers they hold
 * about three-quarters of it.
 */
const COPY_BUDGET = 512 * 1024 * 1024

/** Bead counts below this are fitted on one thread: at 256 beads an evaluation is five milliseconds. */
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
 * Let the likelihood use helper workers — called once, by whatever runs the
 * analysis: the analysis worker in the app, `main` on the command line.
 * `helpers` is how many besides the calling thread; `0` is one thread.
 */
export function useLikelihoodThreads(spawn: () => Worker, helpers: number): void {
  threads = helpers > 0 ? { spawn, helpers: Math.floor(helpers) } : null
}

/** One evaluation of the likelihood and its gradient, wherever it is computed. */
export interface LikelihoodEvaluator {
  /** Threads computing bands, this one included, as the fit started. */
  readonly threads: number
  /** The likelihood at `point`, its gradient written into `gradient`. */
  evaluate(point: Float64Array, gradient: Float64Array): Promise<number>
  /** Terminate every helper. Called once the fit ends, or stops. */
  close(): void
}

interface Helper {
  worker: Worker
  /** Its bands, as indices into the layout: `[from, to)`. */
  from: number
  to: number
  alive: boolean
  /** The evaluation it owes, resolved with its answer — or `null` once it has failed. */
  owed: ((answer: Extract<LikelihoodMessage, { kind: 'shares' }> | null) => void) | null
}

/**
 * Open the likelihood of `model` for evaluation: its bands shared between this
 * thread and as many helpers as are allowed, worth it, and fit in the copy
 * budget. The helpers are sent their rows at once, so they are ready by the
 * time the MDS start has run.
 */
export function openLikelihood(model: NegBinomModel): LikelihoodEvaluator {
  const { counts, n } = model
  const terms = likelihoodTerms(model)
  const edges = likelihoodBands(n)
  const bands = edges.length - 1
  const parts: Float64Array[] = Array.from({ length: bands }, (_, b) => new Float64Array(3 * (n - edges[b])))
  const values = new Float64Array(bands)

  const pool = threads
  const shared = typeof SharedArrayBuffer === 'function' && counts.buffer instanceof SharedArrayBuffer
  const plan =
    pool === null || n < THREAD_FROM
      ? [0, bands]
      : shareBands(edges, n, pool.helpers, shared ? 0 : counts.BYTES_PER_ELEMENT)
  const own = plan[1]
  const id = nextJob++
  let seq = 0

  const helpers: Helper[] = []
  for (let t = 1; pool !== null && t + 1 < plan.length; t++) {
    let worker: Worker
    try {
      worker = pool.spawn()
    } catch {
      // None can be started here: the stretch is this thread's.
      continue
    }
    const helper: Helper = { worker, from: plan[t], to: plan[t + 1], alive: true, owed: null }
    const failed = (): void => {
      if (!helper.alive) return
      helper.alive = false
      helper.worker.onmessage = null
      helper.worker.onerror = null
      helper.worker.terminate()
      const owed = helper.owed
      helper.owed = null
      owed?.(null)
    }
    worker.onmessage = (event: MessageEvent<LikelihoodMessage>) => {
      const message = event.data
      if (message.id !== id) return
      if (message.kind === 'error') {
        failed()
        return
      }
      if (message.seq !== seq || helper.owed === null) return
      const owed = helper.owed
      helper.owed = null
      owed(message)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      failed()
    }
    try {
      const setup = setupFor(id, model, edges, helper.from, helper.to, shared)
      worker.postMessage(setup, shared ? [] : [setup.counts.buffer as ArrayBuffer])
      helpers.push(helper)
    } catch {
      worker.terminate()
    }
  }

  const compute = (b: number, point: Float64Array): void => {
    // A buffer lent to a helper that then failed went with it.
    if (parts[b].length === 0) parts[b] = new Float64Array(3 * (n - edges[b]))
    values[b] = likelihoodBand(terms, counts, null, edges[b], edges[b + 1], point, parts[b])
  }

  return {
    threads: 1 + helpers.length,
    async evaluate(point, gradient) {
      seq++
      const answers = helpers.map((helper) => {
        if (!helper.alive) return Promise.resolve(null)
        return new Promise<Extract<LikelihoodMessage, { kind: 'shares' }> | null>((resolve) => {
          helper.owed = resolve
          const lent: Float64Array[] = []
          for (let b = helper.from; b < helper.to; b++) {
            if (parts[b].length === 0) parts[b] = new Float64Array(3 * (n - edges[b]))
            lent.push(parts[b])
          }
          const request: LikelihoodEvaluate = { kind: 'evaluate', id, seq, point, parts: lent }
          try {
            helper.worker.postMessage(request, lent.map((part) => part.buffer))
          } catch {
            helper.owed = null
            helper.alive = false
            helper.worker.terminate()
            resolve(null)
          }
        })
      })
      for (let b = 0; b < own; b++) compute(b, point)
      // Bands of helpers that could not be started are this thread's too.
      for (let t = 1; t + 1 < plan.length; t++) {
        if (helpers.some((helper) => helper.from === plan[t])) continue
        for (let b = plan[t]; b < plan[t + 1]; b++) compute(b, point)
      }
      const answered = await Promise.all(answers)
      helpers.forEach((helper, at) => {
        const answer = answered[at]
        for (let b = helper.from; b < helper.to; b++) {
          if (answer === null) {
            compute(b, point)
            continue
          }
          values[b] = answer.values[b - helper.from]
          parts[b] = answer.parts[b - helper.from]
        }
      })

      // In band order, as one thread adds them (`negBinomObjective`).
      gradient.fill(0)
      let value = 0
      for (let b = 0; b < bands; b++) {
        const share = values[b]
        if (!Number.isFinite(share)) return Number.POSITIVE_INFINITY
        value += share
        addBand(gradient, parts[b], n, edges[b])
      }
      return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
    },
    close() {
      for (const helper of helpers) {
        if (!helper.alive) continue
        helper.alive = false
        helper.worker.onmessage = null
        helper.worker.onerror = null
        helper.worker.terminate()
        helper.owed?.(null)
        helper.owed = null
      }
    },
  }
}

/**
 * Which bands each thread computes, as indices into the layout: `[0, k₁, …, bands]`,
 * this thread's stretch first and a helper's each after it — as many helpers as
 * are allowed and as there are bands to give them, their stretches equal in
 * work (the bands are), this thread's {@link OWN_SHARE} of one, and fewer
 * helpers where their copies would not fit in {@link COPY_BUDGET}.
 */
export function shareBands(edges: Int32Array, n: number, helpers: number, bytes: number): number[] {
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
    for (let t = 1; t + 1 < plan.length; t++) copies += pairsIn(edges[plan[t]], edges[plan[t + 1]], n) * bytes
    if (plan.length > 2 && copies <= COPY_BUDGET) return plan
  }
  return [0, bands]
}

/** Pairs above the diagonal in rows `[r0, r1)`. */
function pairsIn(r0: number, r1: number, n: number): number {
  let pairs = 0
  for (let i = r0; i < r1; i++) pairs += n - 1 - i
  return pairs
}

/**
 * A helper's setup: its bands' edges, and the counts of their rows above the
 * diagonal, packed — or the shared matrix itself, which costs nothing to send.
 */
function setupFor(
  id: number,
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
    // The counts' own kind of float, so a helper reads the very numbers this thread would.
    const packed = new (counts instanceof Float64Array ? Float64Array : Float32Array)(pairsIn(r0, r1, n))
    let at = 0
    for (let i = r0; i < r1; i++) {
      packed.set(counts.subarray(i * n + i + 1, (i + 1) * n), at)
      at += n - 1 - i
    }
    sent = packed
  }
  return {
    kind: 'setup',
    id,
    n,
    alpha: model.alpha,
    bias: model.bias ?? null,
    dispersion: model.dispersion,
    edges: Array.from(edges.subarray(from, to + 1)),
    counts: sent,
    shared,
  }
}

/**
 * A helper: what it holds between evaluations, and what it does with each
 * message. Here rather than in `worker/likelihood.worker.ts` so that the tests,
 * and the command line's worker threads, run the same code a web worker does.
 */
export function likelihoodHelper(
  send: (message: LikelihoodMessage, transfer?: Transferable[]) => void,
): (request: LikelihoodRequest) => void {
  let held: {
    id: number
    terms: LikelihoodTerms
    counts: DenseMatrix
    edges: number[]
    /** Where each row of each band starts in `counts`, less its first column: `offset + j`. */
    offsets: Float64Array[]
  } | null = null
  return (request) => {
    try {
      if (request.kind === 'setup') {
        const { n, edges, shared } = request
        const offsets: Float64Array[] = []
        let start = 0
        for (let k = 0; k + 1 < edges.length; k++) {
          const rows = new Float64Array(edges[k + 1] - edges[k])
          for (let i = edges[k]; i < edges[k + 1]; i++) {
            // Row `i` of the whole matrix starts at `i·n`; of the packed copy,
            // after the rows before it, at its first column past the diagonal.
            rows[i - edges[k]] = shared ? i * n : start - i - 1
            start += n - 1 - i
          }
          offsets.push(rows)
        }
        held = { id: request.id, terms: likelihoodTerms(request), counts: request.counts, edges, offsets }
        return
      }
      if (held === null || held.id !== request.id) throw new Error('an evaluation before its setup')
      const { terms, counts, edges, offsets } = held
      const n = terms.n
      const values: number[] = []
      const parts: Float64Array[] = []
      for (let k = 0; k + 1 < edges.length; k++) {
        const given = request.parts[k]
        const part = given !== undefined && given.length === 3 * (n - edges[k]) ? given : new Float64Array(3 * (n - edges[k]))
        values.push(likelihoodBand(terms, counts, offsets[k], edges[k], edges[k + 1], request.point, part))
        parts.push(part)
      }
      send({ kind: 'shares', id: request.id, seq: request.seq, values, parts }, parts.map((part) => part.buffer))
    } catch (err) {
      send({ kind: 'error', id: request.id, message: err instanceof Error ? err.message : String(err) })
    }
  }
}
