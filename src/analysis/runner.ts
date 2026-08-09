/**
 * The main thread's half of a job: one queue, one worker, one cache.
 *
 * A job is not a frame — §18's opening paragraph — and everything awkward about
 * this module follows from that one sentence. A frame belongs to the view that
 * drew it and dies with it. A job outlives the view that started it, so this
 * object belongs to the **session** and nothing here may name a mounted view:
 * pan, zoom, open a chromosome, switch tabs and come back, and the scan is still
 * running because the thing that knows about it never moved (§18.3).
 *
 * **One job at a time, queued, FIFO.** Not a limit reluctantly accepted. Two
 * concurrent scans over one byte source thrash it and *both* finish later than
 * they would have in sequence, so the queue is faster than the parallelism it
 * refuses as well as being kinder to the range cache.
 *
 * **The worker is created on the first `run` and never before.** Folding the
 * Analysis panel open to read the list of tasks must cost no thread, no mount
 * and no wasm — the promise `analysis.worker.ts` keeps on its side by leaving
 * `getH5()` out of module scope, and the one a client constructed alongside the
 * session would quietly break here.
 *
 * **A composite is a chain, and the chain is visible.** A task that declares
 * `requires` gets each required result computed first, at that task's own
 * defaults, and handed down in `inputs.upstream` (§18.2). A required result
 * already in the cache is reused when its parameters *and* its framing match —
 * {@link sameRecipe} is that comparison, and it is exported so a test can hold
 * it to the claim. While the chain runs the progress note names the step, which
 * is the only honest answer to "why is this taking so long".
 *
 * **A result is a record and its framing is a snapshot** taken at the instant
 * Run was pressed (§18.4). The framing therefore travels with the queued job
 * rather than being read again at dispatch: a reader who presses Run and then
 * pans has asked for the picture they were looking at, and gets it.
 */

import type { AnnotationPayload, FeatureSet, PairSet } from '../annotations/types'
import { isCancellation, type Cancellable } from '../worker/client'
import type { SourceSpec } from '../worker/protocol'
import { abortError, idParam, listParam } from './job'
import { taskById } from './registry'
import {
  defaultParams,
  type AnalysisContext,
  type AnalysisFraming,
  type AnalysisTask,
  type EntryParam,
  type Params,
  type ParamValue,
  type Provenance,
  type TaskResult,
} from './types'
import type { AnnotationClient } from '../annotations/worker/client'
import { AnalysisClient } from './worker/client'
import { BLOCK_COPY_LIMIT_BYTES, type BlockInput, type TaskInputs } from './worker/protocol'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Where one task stands, as the panel row and the drawer read it.
 *
 * `cancelled` is a state of its own and not a flavour of `failed`, because a
 * reader who pressed Stop knows what happened and does not need a red box to
 * tell them — the same distinction `isCancellation` already draws one layer
 * down.
 */
export type JobState =
  | { status: 'idle' }
  | { status: 'queued' }
  | { status: 'running'; done: number; total: number; note: string; startedAt: number }
  | { status: 'done'; result: TaskResult; ms: number }
  | { status: 'failed'; message: string }
  | { status: 'cancelled' }

/**
 * Everything the runner needs from the session, and nothing it needs from a view.
 *
 * Functions rather than fields, because every one of them is a *reading taken at
 * a moment*: the framing when Run is pressed, the block as it stands at
 * dispatch, the payload of an entry that may have been dropped since the form
 * was filled in. A snapshot handed to the constructor would be stale by the
 * second job.
 */
export interface RunnerHost {
  context(): AnalysisContext | null
  source(): { uri: string; source: SourceSpec } | null
  block(): BlockInput | null
  payload(entryId: string): AnnotationPayload | undefined
  vector?(entryId: string): Promise<Float32Array | undefined>
  /**
   * The annotations worker, for tasks whose venue is the other one (§18.3).
   *
   * Optional, and a task routed there without one fails by name rather than
   * running somewhere it cannot read its own inputs. A `.metacool` has no
   * annotations at all (§8.5), and no task that needs them is offered on it —
   * so in practice the two conditions coincide, which is precisely why the
   * failure has to be loud if they ever stop coinciding.
   */
  annotations?(): AnnotationClient | null
  /** The assembly, so a task in the other venue can clamp a window (§18.3). */
  contigLengths?(): Record<string, number>
  finished(task: AnalysisTask, result: TaskResult): void
  /**
   * A descriptor by id, for resolving `requires`.
   *
   * Optional, and `analysis/registry.ts`'s own `taskById` is the fallback, so a
   * host has to supply this only to override the catalogue — which a test does
   * and the application does not. A requirement that neither resolves fails by
   * name rather than running with an input silently missing, which is the one
   * outcome a composite must never have.
   */
  task?(id: string): AnalysisTask | undefined
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

/**
 * Whether a stored result was computed from the recipe now being asked for.
 *
 * The whole of the composite cache. A saddle asks for eigenvectors; if the
 * eigenvectors in hand were computed from these parameters over this framing
 * then they *are* the answer, and recomputing them would be forty seconds spent
 * arriving at the same numbers. If either differs they are a different question
 * wearing the same task id, and reusing them would put a figure on screen whose
 * provenance line describes a computation that did not produce it.
 *
 * `framing.label` is deliberately not compared: it is prose derived from the
 * fields above it, and a change to how a bin size is spelled would otherwise
 * invalidate every cached result in the session without a single number moving.
 */
export function sameRecipe(a: Provenance, b: { params: Params; framing: AnalysisFraming }): boolean {
  return sameParams(a.params, b.params) && sameFraming(a.framing, b.framing)
}

function sameParams(a: Params, b: Params): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (!(key in b) || !sameValue(a[key], b[key])) return false
  }
  return true
}

/**
 * `ParamValue` is a scalar or a list of ids, so equality is one level deep and
 * `JSON.stringify` would be a longer way of saying the same thing — except on
 * the two values it gets wrong, `NaN` and `-0`, which a numeric parameter is
 * entitled to hold.
 */
function sameValue(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, at) => item === b[at])
  }
  return Object.is(a, b)
}

function sameFraming(a: AnalysisFraming, b: AnalysisFraming): boolean {
  return (
    a.uri === b.uri &&
    a.rows[0] === b.rows[0] &&
    a.rows[1] === b.rows[1] &&
    a.cols[0] === b.cols[0] &&
    a.cols[1] === b.cols[1] &&
    a.binsize === b.binsize &&
    a.binsPerCell === b.binsPerCell &&
    a.balance === b.balance &&
    a.value === b.value &&
    a.level === b.level
  )
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * How often a running job is allowed to repaint the panel.
 *
 * A pixel scan reports progress thousands of times, and a listener that redraws
 * a row per report spends more of the tab's main thread on the progress bar than
 * the job costs it in total. Ten hertz is faster than a reader can read and two
 * orders of magnitude cheaper.
 */
const PROGRESS_NOTIFY_MS = 100

/** One step of a resolved chain: a task, and the parameters it will run with. */
interface PlanStep {
  task: AnalysisTask
  params: Params
}

interface Job {
  task: AnalysisTask
  params: Params
  /** Taken when Run was pressed, not when the worker got to it (§18.4). */
  framing: AnalysisFraming
  /** Set by {@link AnalysisRunner.cancel}; read between chain steps. */
  cancelled: boolean
  /** The step currently on the worker, so a cancel has something to call. */
  running: { id: string; handle: Cancellable<TaskResult> } | null
}

export class AnalysisRunner {
  private readonly host: RunnerHost
  private readonly makeClient: () => AnalysisClient
  private client: AnalysisClient | null = null
  /** The uri this worker has mounted, so `open` is sent once per file. */
  private mounted: string | null = null

  private readonly states = new Map<string, JobState>()
  private readonly results = new Map<string, TaskResult>()
  private readonly queue: Job[] = []
  private current: Job | null = null

  private readonly listeners = new Set<() => void>()
  private lastNotifiedAt = 0
  private trailing: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  /**
   * The client factory is a seam rather than a configuration point: the
   * application always wants the real worker, and a test wants one whose
   * `postMessage` it can answer itself. Defaulted so that the documented
   * one-argument construction is the whole of the public shape.
   */
  constructor(host: RunnerHost, makeClient: () => AnalysisClient = () => new AnalysisClient()) {
    this.host = host
    this.makeClient = makeClient
  }

  stateOf(taskId: string): JobState {
    return this.states.get(taskId) ?? { status: 'idle' }
  }

  resultOf(taskId: string): TaskResult | null {
    return this.results.get(taskId) ?? null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A job is running or waiting to. What the panel's spinner is keyed on. */
  get busy(): boolean {
    return this.current !== null || this.queue.length > 0
  }

  /**
   * Queue `task`.
   *
   * The framing is read here rather than at dispatch, which is what makes a
   * result a record of what the reader was looking at when they asked. A view
   * with no map has no framing and there is nothing to run against — said
   * plainly rather than queued and failed a second later, since the reader is
   * still looking at the button they pressed.
   */
  run(task: AnalysisTask, params: Params): void {
    if (this.destroyed) return
    const framing = this.host.context()?.framing ?? null
    if (framing === null) {
      this.setState(task.id, {
        status: 'failed',
        message: 'this view has no contact map to run against',
      })
      return
    }
    // A second press while the same task is already on the worker is a reader
    // wondering whether the first one registered, not a request for two runs of
    // it. A press while it is still *queued* is a change of mind about the
    // parameters, so the recipe is replaced where it stands — moving it to the
    // back of the queue would punish the correction.
    if (this.current?.task.id === task.id) return
    const waiting = this.queue.find((job) => job.task.id === task.id)
    if (waiting !== undefined) {
      waiting.params = params
      waiting.framing = framing
      return
    }
    this.queue.push({ task, params, framing, cancelled: false, running: null })
    this.setState(task.id, { status: 'queued' })
    this.pump()
  }

  /**
   * Call off a queued or running job.
   *
   * Cooperative for the running one: the worker checks between chunks, so the
   * job stops at the next check and its `AbortError` arrives here as a
   * cancellation rather than as a failure. A job that has already finished is
   * left alone — cancelling a result would be deleting it.
   */
  cancel(taskId: string): void {
    const waiting = this.queue.findIndex((job) => job.task.id === taskId)
    if (waiting >= 0) {
      this.queue.splice(waiting, 1)
      this.setState(taskId, { status: 'cancelled' })
      return
    }
    const job = this.current
    if (job === null || job.task.id !== taskId) return
    job.cancelled = true
    job.running?.handle.cancel()
  }

  /**
   * End the session's analysis: the queue, the jobs and the thread.
   *
   * A job does not survive the session (§18.3), and it ends as `cancelled`
   * rather than as `failed` because terminating the worker is this object's own
   * doing and not a fault the reader needs told about.
   */
  destroy(): void {
    this.destroyed = true
    for (const job of this.queue) this.setState(job.task.id, { status: 'cancelled' })
    this.queue.length = 0
    if (this.current !== null) {
      this.current.cancelled = true
      this.setState(this.current.task.id, { status: 'cancelled' })
    }
    if (this.trailing !== null) {
      clearTimeout(this.trailing)
      this.trailing = null
    }
    this.client?.terminate()
    this.client = null
    this.mounted = null
    this.listeners.clear()
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  private pump(): void {
    if (this.current !== null || this.destroyed) return
    const job = this.queue.shift()
    if (job === undefined) return
    this.current = job
    void this.execute(job).finally(() => {
      this.current = null
      this.pump()
    })
  }

  private async execute(job: Job): Promise<void> {
    const startedAt = performance.now()
    let step: PlanStep | null = null
    this.setState(job.task.id, { status: 'running', done: 0, total: 0, note: 'starting', startedAt })
    try {
      const chain = this.plan(job.task, job.params)
      const client = this.ensureClient()
      await this.mount(job, client, startedAt)

      const upstream: Record<string, TaskResult> = {}
      for (let at = 0; at < chain.length; at++) {
        step = chain[at]
        if (job.cancelled) throw abortError()
        const leaf = step.task.id === job.task.id

        // A cached upstream whose recipe matches is the answer, and the task
        // below never learns whether it was computed now or ten minutes ago
        // (§18.2). The leaf is never taken from the cache: pressing Run means
        // run it.
        const cached = this.results.get(step.task.id)
        if (
          !leaf &&
          cached !== undefined &&
          sameRecipe(cached.provenance, { params: step.params, framing: job.framing })
        ) {
          upstream[step.task.id] = cached
          continue
        }

        const result = await this.runStep(job, client, step, chain, at, upstream, startedAt)
        this.results.set(step.task.id, result)
        if (leaf) {
          this.setState(step.task.id, {
            status: 'done',
            result,
            // Wall clock from dispatch, which for a composite counts the whole
            // chain including the steps that were reused. `result.ms` is the
            // last step's own time, and is what the drawer prints beside it.
            ms: performance.now() - startedAt,
          })
          this.host.finished(job.task, result)
        } else {
          // A required result is cached and its row says so, but it is not
          // handed to `finished`: the reader asked for the saddle, and
          // publishing its eigenvectors as a synthetic track (§18.5) would put
          // lanes on the Annotations panel that nobody asked for.
          upstream[step.task.id] = result
          this.setState(step.task.id, { status: 'done', result, ms: result.ms })
        }
      }
    } catch (err) {
      const cancelled = job.cancelled || isCancellation(err)
      const state: JobState = cancelled
        ? { status: 'cancelled' }
        : { status: 'failed', message: err instanceof Error ? err.message : String(err) }
      // The step that was on the worker stops too, and says the same thing the
      // job does; a chain that left `expected` reading "running" for the rest of
      // the session would be a row nobody could clear.
      if (step !== null && step.task.id !== job.task.id) this.setState(step.task.id, state)
      this.setState(job.task.id, state)
    } finally {
      job.running = null
    }
  }

  /**
   * The mount, opened on the first job that needs one and once per file.
   *
   * The uri is checked against the framing rather than trusted: a queued job
   * whose file was closed and replaced while it waited would otherwise be run
   * against the new one and reported under the old one's provenance, which is
   * the single thing {@link AnalysisFraming.uri} exists to prevent.
   */
  private async mount(job: Job, client: AnalysisClient, startedAt: number): Promise<void> {
    const source = this.host.source()
    if (source === null) throw new Error('no file is open')
    if (source.uri !== job.framing.uri) {
      throw new Error('the open file changed while this job was queued')
    }
    if (this.mounted === source.uri) return
    this.setState(job.task.id, {
      status: 'running',
      done: 0,
      total: 0,
      note: 'opening the file',
      startedAt,
    })
    // Cleared first: an `open` that rejects halfway leaves the worker holding
    // nothing, and a `mounted` still naming the previous file would make the
    // next job skip the open it now needs.
    this.mounted = null
    await client.request<'open'>({ kind: 'open', uri: source.uri, source: source.source })
    this.mounted = source.uri
  }

  private async runStep(
    job: Job,
    client: AnalysisClient,
    step: PlanStep,
    chain: readonly PlanStep[],
    at: number,
    upstream: Record<string, TaskResult>,
    startedAt: number,
  ): Promise<TaskResult> {
    // *expected (1/3)* while the chain runs, and the task's own title while it
    // does not — a step counter on a job with one step is noise beside a
    // progress bar that already says the same thing.
    const label = (note?: string): string => {
      const where =
        chain.length > 1 ? `${step.task.title} (${at + 1}/${chain.length})` : step.task.title
      return note === undefined || note === '' ? where : `${where} — ${note}`
    }
    this.setState(job.task.id, { status: 'running', done: 0, total: 0, note: label(), startedAt })

    const onProgress = (done: number, total: number, note?: string): void => {
      this.setState(
        job.task.id,
        { status: 'running', done, total, note: label(note), startedAt },
        true,
      )
    }
    const payload = {
      kind: 'run' as const,
      task: step.task.id,
      params: step.params,
      framing: job.framing,
      inputs: await this.inputsFor(step, job.framing, upstream),
    }

    let raw: TaskResult
    if (step.task.venue === 'annotations') {
      // The other venue (§18.3). It has no cancel channel of its own — every
      // task routed there is bounded by the feature set it was handed — so this
      // one is awaited rather than made cancellable, and `job.running` stays
      // null so a cancel arriving mid-flight is a no-op rather than a promise
      // nobody settles.
      const tracks = this.host.annotations?.()
      if (tracks === null || tracks === undefined) {
        throw new Error(
          `${step.task.title} runs against the loaded tracks, and this session has no ` +
            'annotations worker.',
        )
      }
      raw = await tracks.request<'run'>(payload, onProgress)
    } else {
      const handle = client.cancellable<'run'>(payload, onProgress)
      job.running = { id: step.task.id, handle }
      raw = await handle.promise
      job.running = null
    }

    // The worker fills `taskVersion` with a placeholder and says in its own
    // comment that this line overwrites it: the descriptor holding the real
    // number is main-thread data, and importing the catalogue into the worker to
    // read one field off it would drag the panel's half of the subtree into that
    // bundle. A result that reaches a reader still carrying `0` means this step
    // was skipped.
    return { ...raw, provenance: { ...raw.provenance, taskVersion: step.task.version } }
  }

  private ensureClient(): AnalysisClient {
    this.client ??= this.makeClient()
    return this.client
  }

  // -------------------------------------------------------------------------
  // Composites
  // -------------------------------------------------------------------------

  /**
   * The chain to run, required tasks first and the asked-for task last.
   *
   * Depth first, so a requirement of a requirement is computed before the thing
   * that wants it, and de-duplicated, because two steps of one chain may want
   * the same expected curve and computing it twice is exactly what `requires`
   * exists to stop. A required task runs at **its own defaults**: the reader
   * configured the saddle and not the eigenvectors underneath it, and inventing
   * parameters for a form they never opened would be putting numbers in their
   * mouth.
   */
  private plan(task: AnalysisTask, params: Params): PlanStep[] {
    const steps: PlanStep[] = []
    const planned = new Set<string>()
    const active = new Set<string>()
    const walk = (node: AnalysisTask, nodeParams: Params): void => {
      if (planned.has(node.id)) return
      // Not merely an infinite loop avoided: a cycle in `requires` is a
      // catalogue mistake, and one that would otherwise present as a tab that
      // stops responding rather than as a sentence naming the task.
      if (active.has(node.id)) throw new Error(`the analysis task ${node.id} requires itself`)
      active.add(node.id)
      for (const id of node.requires ?? []) {
        const required = this.host.task?.(id) ?? taskById(id)
        if (required === undefined) {
          throw new Error(`${node.id} requires the task ${id}, which this session does not offer`)
        }
        walk(required, defaultParams(required.params))
      }
      active.delete(node.id)
      planned.add(node.id)
      steps.push({ task: node, params: nodeParams })
    }
    walk(task, params)
    return steps
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /**
   * What the job carries with it: the loaded sets it named, and maybe the block.
   *
   * Assembled at dispatch rather than when Run was pressed, because a feature
   * set is megabytes of typed arrays and a queued job holding one would keep it
   * alive after the reader dropped it. The framing is the exception, and it is
   * the exception for the reason §18.4 gives.
   */
  private async inputsFor(
    step: PlanStep,
    framing: AnalysisFraming,
    upstream: Record<string, TaskResult>,
  ): Promise<TaskInputs> {
    const features: Record<string, FeatureSet> = {}
    const pairs: Record<string, PairSet> = {}
    const vectors: Record<string, Float32Array> = {}

    for (const spec of step.task.params) {
      if (
        spec.kind !== 'featureSet' &&
        spec.kind !== 'pairSet' &&
        spec.kind !== 'track' &&
        spec.kind !== 'sequence'
      ) {
        continue
      }
      for (const [key, entryId] of chosenEntries(spec, step.params)) {
        if (spec.kind === 'track' || spec.kind === 'sequence') {
          // A **sequence** arrives as a vector and not as bases, and that is the
          // whole of how GC-content phasing crosses the venue boundary (§18.6).
          // The residues live in the annotations worker and are megabytes; what
          // the compartments task needs is one number per bin, which `sample`
          // already computes for the lane it draws. Asking for the vector rather
          // than for a third venue is the small fix that open question 6 named.
          //
          // Only for a task that runs *here*: the annotations venue holds the
          // handles itself, so shipping the same numbers to it would be sending
          // a worker a copy of what it is about to read.
          if (step.task.venue === 'annotations') continue
          const vector = await this.host.vector?.(entryId)
          if (vector !== undefined) vectors[key] = vector
          continue
        }
        // An entry that is gone — dropped after the form was filled in — is
        // left out rather than replaced by an empty set, so the runner sees a
        // missing input and can name it instead of reporting a clean aggregate
        // over nothing.
        const payload = this.host.payload(entryId)
        if (payload === undefined) continue
        if (spec.kind === 'featureSet' && payload.kind === 'features') features[key] = payload.data
        if (spec.kind === 'pairSet' && payload.kind === 'pairs') pairs[key] = payload.data
      }
    }

    const inputs: TaskInputs = {}
    if (Object.keys(features).length > 0) inputs.features = features
    if (Object.keys(pairs).length > 0) inputs.pairs = pairs
    // Only for the other venue, which has no assembly of its own: the
    // annotations worker holds handles and parsed sets, and neither knows how
    // long a sequence is. Sent for that venue alone rather than always, because
    // on a metagenome it is four thousand entries the analysis worker would
    // never read.
    if (step.task.venue === 'annotations') {
      const lengths = this.host.contigLengths?.()
      if (lengths !== undefined) inputs.contigLengths = lengths
    }
    if (Object.keys(vectors).length > 0) inputs.vectors = vectors
    if (Object.keys(upstream).length > 0) inputs.upstream = { ...upstream }

    const block = this.host.block()
    if (block !== null && blockWorthCopying(block) && blockMatches(block, framing)) {
      // **Copied, never transferred**, which is why the size gate above is
      // worth having at all. `Transferable` is the optimisation that looks free
      // here and is the one that blanks the map: the buffer handed away is the
      // array the heatmap draws from, and what is left behind is a neutered view
      // and an empty canvas several frames from its cause (§18.3).
      inputs.block = block
    }
    return inputs
  }

  // -------------------------------------------------------------------------
  // Notification
  // -------------------------------------------------------------------------

  private setState(taskId: string, state: JobState, throttled = false): void {
    this.states.set(taskId, state)
    if (throttled) this.notifySoon()
    else this.notifyNow()
  }

  private notifyNow(): void {
    if (this.trailing !== null) {
      clearTimeout(this.trailing)
      this.trailing = null
    }
    this.lastNotifiedAt = performance.now()
    // Over a copy: a listener that unsubscribes itself while being called — a
    // drawer closing on the very result it was told about — must not shorten
    // the set being walked.
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * A progress report, at no more than {@link PROGRESS_NOTIFY_MS}.
   *
   * With a trailing call rather than a bare rate limit: a job whose last report
   * lands inside the window and then works for a minute without another would
   * otherwise leave the panel showing the second-to-last number for that minute.
   */
  private notifySoon(): void {
    const wait = PROGRESS_NOTIFY_MS - (performance.now() - this.lastNotifiedAt)
    if (wait <= 0) {
      this.notifyNow()
      return
    }
    if (this.trailing !== null) return
    this.trailing = setTimeout(() => {
      this.trailing = null
      this.notifyNow()
    }, wait)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The entries one parameter chose, each with the key its input is filed under.
 *
 * A single-valued parameter files its input under the parameter key, which is
 * what {@link TaskInputs} means by "keyed by the parameter key that chose them".
 * A `multiple` one cannot — five tracks do not fit in one slot — so each is
 * filed under `key:entryId`, which a runner rebuilds from `listParam(params,
 * key)` because that is the list the keys were built from. Keying multiples by
 * entry id alone would collide the moment one task took two multi-selects.
 */
function chosenEntries(spec: EntryParam, params: Params): Array<[string, string]> {
  if (spec.multiple === true) {
    return listParam(params, spec.key).map((id): [string, string] => [`${spec.key}:${id}`, id])
  }
  const id = idParam(params, spec.key)
  return id === null ? [] : [[spec.key, id]]
}

/**
 * Whether the block is small enough that cloning it beats reading it again.
 *
 * The host is expected to have applied the same limit before making the copy it
 * hands over — `MatrixPanel.analysisBlock` does — and it is checked again here
 * anyway, because the limit protects the frame that performs the structured
 * clone and a second host getting it wrong would show up as a stalled tab rather
 * than as a slow analysis.
 */
function blockWorthCopying(block: BlockInput): boolean {
  return block.values.byteLength <= BLOCK_COPY_LIMIT_BYTES
}

/**
 * Whether the block still describes the framing this job was started with.
 *
 * The framing is a snapshot and the block is not: a job that waited behind
 * another one while the reader panned would otherwise be handed the pixels of a
 * different region under the extents of the one it recorded. Where the two
 * disagree the block is simply left off and the worker reads for itself at the
 * file's own resolution, which is what its second mount is for.
 */
function blockMatches(block: BlockInput, framing: AnalysisFraming): boolean {
  return (
    block.rowExtent[0] === framing.rows[0] &&
    block.rowExtent[1] === framing.rows[1] &&
    block.colExtent[0] === framing.cols[0] &&
    block.colExtent[1] === framing.cols[1] &&
    block.binsPerCell === framing.binsPerCell
  )
}
