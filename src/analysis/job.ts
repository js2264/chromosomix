/**
 * What a task is handed when it runs.
 *
 * Worker-side only, and that is the point of it being a separate module from
 * `analysis/types.ts`. A {@link JobContext} names `MetaCooler`, and
 * `worker/reader.worker.ts` opens with the claim that it is the only module in
 * `src/worker/` and `src/ui/` that does. Keeping the *descriptors* (which the
 * panel, the form and the registry all import on the main thread) apart from the
 * *runners* (which only this worker imports) is what keeps that claim true, and
 * it is why every task is two files: `analysis/tasks/<id>.ts` for what the task
 * is, `analysis/run/<id>.ts` for what it does.
 *
 * The four capabilities below are the whole of what a runner may assume, and
 * each is here because leaving it to the runner produced a bug at least once in
 * the modules this design is derived from:
 *
 * - **`throwIfCancelled`** rather than a boolean nobody checks. A scan that
 *   ignores a cancel is a scan the reader cannot get out of, and the honest
 *   place to notice is inside the loop.
 * - **`progress`** with a note, because a composite's honest answer to "why is
 *   this slow" is which of its steps is running.
 * - **`note`** for the things a reader must be told that are not errors —
 *   *412 of 5,000 windows dropped for missing data*. A task that silently
 *   discards a fifth of its input and reports a clean number is a task that
 *   lies, and there is nowhere else for that sentence to go.
 * - **`bp` and `bins` conversions bound to the open file**, because a parameter
 *   is typed in base pairs and every kernel below works in bins, and doing that
 *   arithmetic at each of a dozen call sites is how one of them ends up off by a
 *   bin at a contig edge.
 */

import type { Region, TrackSampleSet } from '../annotations/types'
import type { MetaCooler } from '../metacooler/MetaCooler'
import type { AnalysisFraming, Params, ParamValue, TaskOutput } from './types'
import type { TaskInputs } from './worker/protocol'

export interface JobContext {
  /** The file, mounted by this worker and nobody else. */
  readonly mc: MetaCooler
  readonly params: Params
  readonly framing: AnalysisFraming
  readonly inputs: TaskInputs
  /** `true` once the reader has asked for this job to stop. */
  cancelled(): boolean
  /** @throws an `AbortError` when {@link cancelled}. Call it inside loops. */
  throwIfCancelled(): void
  progress(done: number, total: number, note?: string): void
  /** Something the reader should know that is not an error. */
  note(text: string): void
  /** Base pairs for a whole number of bins of this file. */
  toBp(bins: number): number
  /** Bins for a span in base pairs, rounded to at least one. */
  toBins(bp: number): number
}

/** What a task actually does. Registered in `analysis/run/index.ts`. */
export type TaskRunner = (job: JobContext) => Promise<TaskOutput[]>

// ---------------------------------------------------------------------------
// Reading parameters
// ---------------------------------------------------------------------------

/**
 * The four accessors every runner uses.
 *
 * `Params` is `Record<string, ParamValue>` because it has to survive
 * `postMessage`, `JSON.stringify` and a session file written by an older build —
 * so what arrives is genuinely of unknown shape, and a runner that indexes it
 * directly is a runner that reads `undefined` out of a renamed key and computes
 * with `NaN` all the way to a plot. These narrow, and fall back rather than
 * throw: a missing parameter is a build that changed, not a file that is broken.
 */
export function numParam(params: Params, key: string, fallback: number): number {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function strParam(params: Params, key: string, fallback: string): string {
  const value = params[key]
  return typeof value === 'string' ? value : fallback
}

export function boolParam(params: Params, key: string, fallback: boolean): boolean {
  const value = params[key]
  return typeof value === 'boolean' ? value : fallback
}

/** A multi-select's value, as a plain array of ids. Never `undefined`. */
export function listParam(params: Params, key: string): string[] {
  const value: ParamValue | undefined = params[key]
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  return typeof value === 'string' && value !== '' ? [value] : []
}

/** An optional entry choice: the id, or `null` where nothing was picked. */
export function idParam(params: Params, key: string): string | null {
  const value = params[key]
  return typeof value === 'string' && value !== '' ? value : null
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

/**
 * The rejection a cancelled job produces.
 *
 * `AbortError` by name, because `worker/client.ts`'s `isCancellation` already
 * tests for exactly that and the UI already maps it to a quiet no-op rather than
 * to an error card. A second convention for the same event would mean a
 * cancelled analysis showing a red box saying "cancelled".
 */
export function abortError(): Error {
  const err = new Error('cancelled')
  err.name = 'AbortError'
  return err
}

// ---------------------------------------------------------------------------
// The other venue
// ---------------------------------------------------------------------------

/**
 * What a task is handed when it runs in the **annotations** worker.
 *
 * Two venues rather than one, and the split is the same argument
 * `annotations/worker/protocol.ts` already makes for itself. A metaplot's whole
 * input is bigWigs and feature sets: the handles are already open in that
 * worker, it already answers many regions in one request, and it already picks a
 * zoom level for the batch. Routing that through a third thread would mean
 * shipping the samples out of the worker that has them, into a worker that has
 * no reader for them, to average numbers neither of them needed to move — and
 * would land N × W floats on the main thread on the way past, which is exactly
 * the point §18.8 says would be missed.
 *
 * So a task declares its {@link TaskVenue} and the runner routes. What the two
 * contexts share is deliberate and complete: cancellation, progress, notes and
 * the inputs. What differs is the one capability each venue exists for — a
 * mounted `MetaCooler` there, a way to sample a track here.
 */
export interface TrackJobContext {
  readonly params: Params
  readonly framing: AnalysisFraming
  readonly inputs: TaskInputs
  cancelled(): boolean
  throwIfCancelled(): void
  progress(done: number, total: number, note?: string): void
  note(text: string): void
  /**
   * Values over a set of regions, at a chosen resolution.
   *
   * One call per batch rather than per region, because that is what the worker's
   * own `sample` is built to do: it picks a single zoom level for the whole
   * request and coalesces on-disk blocks across region boundaries (§8.2).
   */
  sample(entry: string, regions: Region[], basesPerPixel: number): Promise<TrackSampleSet>
  /** A sequence's length, so a window can be clamped to it rather than past it. */
  lengthOf(contig: string): number | undefined
}

export type TrackTaskRunner = (job: TrackJobContext) => Promise<TaskOutput[]>
