/**
 * The analysis worker — the thread a job runs on, and nothing else.
 *
 * It is the third thread of the arrangement `analysis/worker/protocol.ts`
 * argues for: the reader worker answers the frames, the annotations worker
 * answers the tracks, and this one takes the work that is measured in seconds
 * and minutes, so that neither of the other two ever queues behind it (§18.3).
 *
 * Two things follow from that and are worth stating as properties rather than
 * as intentions.
 *
 * **It is a second mount of the same file, not a second reader.** It opens the
 * source for itself through the same `worker/sources.ts` the reader uses, so a
 * dropped `File` costs nothing at all here and a remote object costs a second
 * range cache. It answers no view request, holds no dense block and reports no
 * byte statistics; everything it produces is a {@link TaskResult}.
 *
 * **It knows nothing about the task catalogue.** A `run` names a task id and
 * this module looks it up in `analysis/run/index.ts` — the descriptors in
 * `analysis/tasks/` are a main-thread concern (`analysis/job.ts` says why the
 * split is load-bearing), and importing the registry here to read one number off
 * a descriptor would drag the panel's half of the subtree into this bundle. The
 * one place that costs anything is `provenance.taskVersion`, and it is paid for
 * below.
 *
 * Like `worker/reader.worker.ts`, this module names `MetaCooler`; unlike it,
 * nothing in `src/worker/` or `src/ui/` does, so the reader's claim to be the
 * only such module *there* is untouched.
 */

import { yieldToEventLoop } from '../../async'
import { LOAD_REPORT_MS, startBusyProbe } from '../../perf/busy'
import { ViewerError } from '../../errors'
import { MetaCooler } from '../../metacooler/MetaCooler'
import type { ByteSource } from '../../types'
import { COMMIT, VERSION } from '../../version'
import { serialiseError } from '../../worker/protocol'
import { createDetachedSource, releaseSources } from '../../worker/sources'
import { openMap } from '../../worker/open'
import { correlationField, type CorrelationField } from '../compartments'
import { useCorrelationThreads } from '../pearsonThreads'
import { spawnGramWorker } from './spawnGram'
import { adaptiveSmoothValues } from '../../render/smooth'
import { abortError, type JobContext } from '../job'
import { RUNNERS } from '../run/index'
import type { TaskResult } from '../types'
import {
  analysisTransfers,
  type ResampleTarget,
  type AnalysisRequest,
  type AnalysisResponse,
  type AnalysisResultMap,
} from './protocol'
import type { SmoothedField } from '../../render/derive'

/**
 * `lib` includes both DOM and WebWorker, so `self` is typed as a window here.
 * One cast, at the top, rather than a cast per `postMessage`.
 */
const ctx = self as unknown as DedicatedWorkerGlobalScope

// The correlation matrix — the map's correlation and the compartment chain's —
// shares its bands with helper workers, one fewer than the cores, since this
// thread computes a stretch of its own (`pearsonThreads.ts`). Seven at most:
// past that the copies of the rows cost more than the cores give back.
useCorrelationThreads(
  spawnGramWorker,
  Math.max(0, Math.min(7, (typeof navigator === 'undefined' ? 1 : navigator.hardwareConcurrency || 1) - 1)),
)

// The reader worker starts fetching h5wasm at module scope, while the user is
// still choosing a file, because it is certain to need it within the second.
// This worker deliberately does not, and the difference is not an oversight: it
// may never open anything at all. A reader who folds the Analysis panel open,
// reads the list of tasks and folds it again has just been charged a 4.8 MB
// async chunk — download, parse and instantiate — for a mount that was never
// made, which is the exact opposite of the lazy mount §18.3 promises. `getH5()`
// is reached from `MetaCooler.open` below, on the first task that needs a file,
// and memoises from there.

interface Session {
  mc: MetaCooler
  /**
   * The mount's byte source, held for its lifetime.
   *
   * Not read by anything here — this worker publishes no statistics — but the
   * handle `mc` closes is a lent view of it (`worker/sources.ts`), so the thing
   * that actually owns the bytes has to be somewhere until `releaseSources`.
   */
  source: ByteSource
}

let session: Session | null = null
const cancelled = new Set<number>()

function requireSession(): Session {
  // Not an implicit mount: a `run` names a task and carries no uri and no
  // source, so there is nothing here to open a file *from*. A run before an open
  // is a fault in the main-thread runner's ordering, and says so.
  if (session === null) throw new Error('no file is open in the analysis worker')
  return session
}

function post(response: AnalysisResponse, transfers: Transferable[] = []): void {
  ctx.postMessage(response, transfers)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOpen(
  request: Extract<AnalysisRequest, { kind: 'open' }>,
): Promise<AnalysisResultMap['open']> {
  session?.mc.close()
  session = null
  // A cancel that arrives after its target finished leaves its id behind, since
  // the `finally` that would have removed it has already run. Harmless
  // individually and unbounded over a session, so it is cleared with the file
  // the ids belonged to.
  cancelled.clear()

  // Through `openMap`, not `MetaCooler.open`: a HiC-Pro pair is two text files
  // and no HDF5 at all, and calling the HDF5 road directly reached h5wasm with a
  // `.matrix` and failed inside it — `error - name not defined!` — for every
  // task on a map that was on screen and perfectly fine (`worker/open.ts`).
  const opened = await openMap(request.uri, request.source, {
    report: (done, total, note) => post({ type: 'progress', id: request.id, done, total, note }),
    cancelled: () => cancelled.has(request.id),
    // Carried rather than re-asked: a contact list has no resolution of its own
    // and the reader chose one when the *first* worker opened it (§3.7).
    ...(request.binning === undefined ? {} : { binning: request.binning }),
  })
  const source = opened.source
  let mc = opened.mc
  // Through the edit the reader's map is drawn through (§27.7), before anything
  // reads it: a task on an edited map measures the edited assembly. Refused by
  // name where it cannot be, rather than measuring the file as it was under a
  // view that says otherwise.
  if (request.edit !== undefined) {
    const seen = MetaCooler.withLens(mc, request.edit)
    if (seen.refusal !== null) {
      mc.close()
      throw new ViewerError('unsupported', seen.refusal)
    }
    mc = seen.map
  }
  // The cells the reader has ticked, not the file's whole set. A task measures
  // what is on screen, and an scool with two cells selected draws two: opening
  // the pseudo-bulk here would answer a question about four thousand cells with
  // the same number every time and no way to tell (§3.8).
  if (request.cells !== undefined && mc.cells.length > 0) mc.selectCells(request.cells)
  // Drawn as the reader drew it, before any task reads it (§6.5). Awaited here,
  // so a refusal fails the mount by name rather than every task after it.
  if (request.resample !== undefined) await drawnAs(mc, request.resample, request.id)
  // At the resolution the reader added, where the map is drawn at one (§3.4):
  // last, so it sums the map as drawn — through the edit, at the total — as the
  // reader's own read does.
  if (request.coarsen !== undefined) {
    try {
      mc = atResolution(mc, request.coarsen)
    } catch (error) {
      mc.close()
      throw error
    }
  }
  session = { mc, source }

  // Two numbers and no table. Everything else about the file is already on the
  // main thread from the reader's own open, and answering with a second copy of
  // it would be a second thing to keep in step; these two are here because
  // `toBins` below is defined in terms of one of them and the caller has a right
  // to check that the two mounts agree about the file.
  return { nBins: mc.nBins, binsize: mc.binsize }
}

/**
 * A map read at `binsize` (§3.4): its own bins summed, a whole number at a time,
 * or the map itself where they are already that size. Refused by name rather
 * than read at the nearest resolution it has — a task measured at another
 * resolution than the one its framing names is the wrong number with the right
 * label.
 */
function atResolution(mc: MetaCooler, binsize: number): MetaCooler {
  if (binsize === mc.binsize) return mc
  const factor = binsize / mc.binsize
  if (!Number.isInteger(factor) || factor < 1) {
    throw new ViewerError(
      'unsupported',
      `This map's bins are ${mc.binsize.toLocaleString('en-US')} bp, and ` +
        `${binsize.toLocaleString('en-US')} bp is not a whole number of them, so it is not measured at that resolution.`,
    )
  }
  const seen = MetaCooler.coarsened(mc, factor)
  if (seen.refusal !== null) throw new ViewerError('unsupported', seen.refusal)
  return seen.map
}

/**
 * Draw a mount to the reader's total (§6.5), with the reader's census where it
 * was handed one — the same pixels, without walking the file a second time.
 */
async function drawnAs(mc: MetaCooler, target: ResampleTarget, id: number): Promise<void> {
  await mc.resample(
    {
      contacts: target.contacts,
      ...(target.seed === undefined ? {} : { seed: target.seed }),
      ...(target.alpha === undefined ? {} : { alpha: target.alpha }),
    },
    {
      ...(target.census === undefined ? {} : { census: target.census }),
      onProgress: (done, total) => post({ type: 'progress', id, done, total, note: 'counting contacts' }),
      cancelled: () => cancelled.has(id),
    },
  )
}

/**
 * The version stamped on a result produced here.
 *
 * The descriptor that owns the real number lives in `analysis/registry.ts` on
 * the main thread, and this worker does not import it (see the module docstring)
 * — so the field is filled with a placeholder and **overwritten by the
 * main-thread runner** as the result comes back, before anything stores it,
 * draws it or writes it into an export. A result that reached a reader still
 * carrying `0` would mean the runner skipped that step.
 */
const UNSTAMPED_TASK_VERSION = 0

/**
 * The build that produced a number, for the `#` provenance line above it.
 *
 * `VERSION` alone on a build with no git behind it — a source tarball, or
 * `vitest`, which applies none of the `define` block — rather than a trailing
 * separator with nothing after it. Not `buildLine()`: that is composed for the
 * about dialog and carries the commit date and the target as well, which is more
 * than a provenance header needs and one more thing to diff when comparing two
 * results.
 */
const APP = [VERSION, COMMIT].filter((part) => part !== '').join(' ')

async function handleRun(
  request: Extract<AnalysisRequest, { kind: 'run' }>,
): Promise<TaskResult> {
  const runner = RUNNERS[request.task]
  if (runner === undefined) {
    // Named, because the id is the only thing that distinguishes this from a
    // registry that is simply empty — and a task offered by the panel and absent
    // from `RUNNERS` is exactly the mismatch `test/unit/analysis-registry.test.ts`
    // exists to catch before a reader ever clicks the row.
    throw new Error(`no analysis runner is registered for the task ${request.task}`)
  }
  const { mc } = requireSession()
  const id = request.id
  const notes: string[] = []
  const started = performance.now()

  const job: JobContext = {
    mc,
    params: request.params,
    framing: request.framing,
    inputs: request.inputs,
    cancelled: () => cancelled.has(id),
    throwIfCancelled: () => {
      if (cancelled.has(id)) throw abortError()
    },
    // The event loop first and the flag second, in that order: the whole point
    // is to let the `cancel` message that is already queued be *delivered*, and
    // reading the flag before yielding would read it exactly as stale as
    // `throwIfCancelled` does. See `analysis/job.ts`.
    breathe: async () => {
      await yieldToEventLoop()
      if (cancelled.has(id)) throw abortError()
    },
    progress: (done, total, note) => post({ type: 'progress', id, done, total, note }),
    note: (text) => {
      notes.push(text)
    },
    toBp: (bins) => bins * mc.binsize,
    // At least one bin, because every caller of this is sizing a window, and a
    // window of zero bins is a kernel that reads nothing and returns a clean
    // number. A flank smaller than the bin size is a question this file cannot
    // answer at the resolution asked for; the honest floor is the resolution it
    // has.
    toBins: (bp) => Math.max(1, Math.round(bp / mc.binsize)),
    // A **second** mount inside this worker, for the length of one computation.
    // Detached from the source cache the first one uses, because that cache
    // holds one local and one remote mount and releasing the held one is how it
    // makes room — which on the local road would close the file this very task
    // is reading through (`worker/sources.ts`).
    // Bytes rather than a container, for a file this application reads and does
    // not mount — see `JobContext.openBytes`. Detached from the mount cache for
    // the same reason `peer` is.
    openBytes: async (url) => await createDetachedSource({ kind: 'remote', url }),
    // And a file the form was handed rather than told the address of — a
    // dropped `File`, or a picked row carrying what authorises it.
    openSource: async (spec) => await createDetachedSource(spec),
    peer: async (map) => {
      const opened = await openMap(map.uri, map.source, {
        report: (done, total, note) => post({ type: 'progress', id, done, total, note }),
        cancelled: () => cancelled.has(id),
        detached: true,
        ...(map.binning === undefined ? {} : { binning: map.binning }),
      })
      if (map.cells !== undefined && opened.mc.cells.length > 0) {
        opened.mc.selectCells(map.cells)
      }
      if (map.resample !== undefined) {
        try {
          await drawnAs(opened.mc, map.resample, id)
        } catch (error) {
          opened.mc.close()
          opened.source.close()
          throw error
        }
      }
      // At the resolution the map it is compared with is read at, where its own
      // bins sum to it; where they do not, as it is — and the task, which
      // compares bin sizes before it compares anything, says so (§3.4).
      let mc = opened.mc
      if (map.coarsen !== undefined) {
        try {
          mc = atResolution(opened.mc, map.coarsen)
        } catch {
          mc = opened.mc
        }
      }
      return {
        mc,
        close: () => {
          mc.close()
          opened.source.close()
        },
      }
    },
  }

  const outputs = await runner(job)
  // A runner whose last loop finished just as the cancel landed would otherwise
  // deliver a complete result to a reader who has already dismissed the drawer.
  job.throwIfCancelled()

  return {
    outputs,
    provenance: {
      task: request.task,
      taskVersion: UNSTAMPED_TASK_VERSION,
      // The parameters and the framing as they arrived, not as the runner read
      // them: provenance is a record of what was asked for, and a runner's
      // fallback for a key an older session did not have is part of the answer
      // rather than part of the question.
      params: request.params,
      framing: request.framing,
      app: APP,
      createdAt: new Date().toISOString(),
    },
    notes,
    ms: performance.now() - started,
  }
}

/**
 * The correlation of a square the view handed over.
 *
 * The one handler that needs **no mount**, and the only one: everything it works
 * on arrived in the message. So it deliberately does not call `requireSession`
 * — a reader who turns the map's correlation toggle on should not thereby open a
 * second HDF5 handle on their file, and would be very surprised to be told the
 * worker had not been opened yet.
 *
 * Progress and cancellation come from the row hook `correlationMatrix` already
 * takes for exactly this, and the yield is what makes the cancel real: a `cancel`
 * message cannot be *delivered* to a thread that never returns to its event
 * loop, so a check without a yield asks about a message that could not have
 * arrived (`analysis/job.ts`). Every sixty-fourth row, which is the same batch
 * size the task runner breathes on — the round trip is paid once a batch instead
 * of `m` times.
 */
async function handleCorrelate(request: Extract<AnalysisRequest, { kind: 'correlate' }>): Promise<
  CorrelationField
> {
  const id = request.id
  const total = request.n
  const field = await correlationField(request.values, request.n, async (row) => {
    if (row % CORRELATE_BATCH_ROWS !== 0) return
    await yieldToEventLoop()
    if (cancelled.has(id)) throw abortError()
    post({ type: 'progress', id, done: row, total, note: 'correlating' })
  })
  // As `handleRun` does, and for its reason: a job whose last row finished just
  // as the cancel landed would otherwise deliver a full square to a reader who
  // has already switched the toggle off.
  if (cancelled.has(id)) throw abortError()
  return field
}

/**
 * Rows between yields while correlating.
 *
 * The trade is the same one everywhere in this file: yielding per row turns an
 * `m`-row job into `m` round trips through the event loop, and yielding never
 * makes the cancel a lie. Sixty-four rows of a thousand-bin square is a few tens
 * of milliseconds, which is the granularity a reader experiences as "it stopped
 * when I asked".
 */
const CORRELATE_BATCH_ROWS = 64

/**
 * The adaptive despeckle of one block.
 *
 * Synchronous, unlike the correlation beside it, and that is a deliberate
 * difference rather than an omission. The filter's two passes are banded over
 * rows and each band's tables are built and thrown away together; there is no
 * consistent state to stop at partway through one, and threading a yield through
 * both passes would buy a cancel that lands a few hundred milliseconds sooner on
 * a job the reader is no longer waiting for anyway.
 *
 * What that costs is that a superseded job runs to completion instead of being
 * cut short. It is bounded: the cancel is checked **before** the work as well as
 * after, so a job cancelled while it sat in the queue never starts, and only the
 * one already running is wasted.
 */
function handleSmooth(
  request: Extract<AnalysisRequest, { kind: 'smooth' }>,
): SmoothedField {
  if (cancelled.has(request.id)) throw abortError()
  const smoothed = adaptiveSmoothValues(
    { nrows: request.nrows, ncols: request.ncols, values: request.values },
    request.counts,
    request.spec,
    request.over ?? undefined,
  )
  // As `handleRun` does, and for its reason: a job whose last band finished just
  // as the cancel landed would otherwise deliver a picture to a reader who has
  // already moved the picker.
  if (cancelled.has(request.id)) throw abortError()
  return {
    values: smoothed.values,
    over: smoothed.over,
    applied: smoothed.applied,
    scope: smoothed.scope,
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatch(request: AnalysisRequest): Promise<unknown> {
  switch (request.kind) {
    case 'open':
      return handleOpen(request)
    case 'run':
      return handleRun(request)
    case 'correlate':
      return handleCorrelate(request)
    case 'smooth':
      return handleSmooth(request)
    case 'cancel':
      cancelled.add(request.target)
      return null
    case 'close':
      session?.mc.close()
      session = null
      cancelled.clear()
      // The handle's `close` returns the *borrowed* source; this is what
      // actually releases the mount and its chunk cache (`worker/sources.ts`).
      releaseSources()
      return null
  }
}

async function handle(request: AnalysisRequest): Promise<void> {
  try {
    const payload = await dispatch(request)
    post(
      { type: 'result', id: request.id, kind: request.kind, payload },
      analysisTransfers(payload),
    )
  } catch (err) {
    post({ type: 'error', id: request.id, error: serialiseError(err) })
  } finally {
    cancelled.delete(request.id)
  }
}

ctx.onmessage = (event: MessageEvent<AnalysisRequest>): void => {
  void handle(event.data)
}

// How busy this thread has been, once a second, unasked — the same probe the
// other two workers run. It matters most here: a job is the longest thing this
// tab does, and it is the one stretch during which a CPU figure taken from the
// main thread alone would read 0%.
const probe = startBusyProbe()
setInterval(() => post({ type: 'busy', fraction: probe.busy() }), LOAD_REPORT_MS)
