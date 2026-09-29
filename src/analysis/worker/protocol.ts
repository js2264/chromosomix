/**
 * The analysis worker's vocabulary.
 *
 * A **third** worker beside the reader's and the annotations', and the reason is
 * a requirement rather than a preference: a long analysis must not stop the
 * reader from panning (§18.3).
 *
 * The reader worker owns the HDF5 mount and answers `matrix` requests, so a scan
 * inside it makes the next pan wait behind minutes of arithmetic. The
 * annotations worker exists for exactly this argument one level down — its own
 * header says a `sample` behind a whole-genome pixel scan would wait, so tracks
 * got a thread of their own. This is the same argument a third time, with a
 * longer job: an insulation pass over a metagenome, a whole-genome 4C, five
 * thousand pileup windows.
 *
 * So this worker takes its own mount of the same source. A local `File` is
 * structured-cloneable by reference, so a second handle on a dropped file costs
 * nothing at all; a remote one costs a second range cache, and the overlap is
 * expected to be small because an analysis mostly reads pixels the view never
 * asks for. The mount is opened on the **first task that needs it** and closed
 * with the session, so a reader who never opens the panel pays nothing.
 *
 * Two properties follow and are worth stating as contract rather than as
 * intention, because §12's first analysis budget row is exactly them:
 *
 * - **no analysis ever runs on the main thread**, not even a cheap one — a rule
 *   with an exception is a rule a frame gets dropped through;
 * - **the reader worker is never given analysis work**, which is what makes the
 *   map stay live for the whole duration by construction rather than by care.
 */

import type { FeatureSet, PairSet } from '../../annotations/types'
import type {
  OrientationSummary,
  PairsBinning,
  SerialisedError,
  SourceSpec,
} from '../../worker/protocol'
import type { CorrelationField } from '../compartments'
import type { Census } from '../../metacooler/resample'
import type { SmoothedField } from '../../render/derive'
import type { Smoothing } from '../../render/smooth'
import type { AnalysisFraming, Params, TaskResult } from '../types'

// ---------------------------------------------------------------------------
// Inputs a job carries with it
// ---------------------------------------------------------------------------

/**
 * A dense block the view already holds, copied rather than transferred.
 *
 * **Copied**, and that is deliberate: `Transferable` would neuter the array the
 * heatmap is drawing from, so the one optimisation that looks free here is the
 * one that blanks the map. A copy is only offered when the block is small enough
 * for it to be genuinely cheap — see {@link BLOCK_COPY_LIMIT_BYTES} — and
 * otherwise the worker reads for itself, which is the case the second mount
 * exists for.
 */
export interface BlockInput {
  nrows: number
  ncols: number
  values: Float32Array
  rowExtent: [number, number]
  colExtent: [number, number]
  /** Bins summed per cell, or 1. Mirrors `AnalysisFraming.binsPerCell`. */
  binsPerCell: number
}

/**
 * The largest block worth copying into the worker.
 *
 * A yeast chromosome at 1 kb is 1,531² cells — 9 MB, and structured-cloning that
 * costs a few milliseconds against the tens of milliseconds of range requests it
 * saves. A whole yeast genome at 1 kb is 12,100² and 586 MB, where the copy is
 * itself the expensive operation and would stall the main thread doing it. 64 MB
 * is comfortably above the first and far below the second.
 */
export const BLOCK_COPY_LIMIT_BYTES = 64 << 20

/**
 * Everything a job needs that lives on the main thread rather than in the file.
 *
 * Feature and pair sets are parsed once by the annotations worker and handed to
 * the main thread whole (§8.4), so the main thread is where they are — and they
 * are typed arrays plus a `string[]`, which crosses `postMessage` without a
 * serialiser. Keyed by the parameter key that chose them, so a task that takes
 * two feature sets gets two, told apart by which control they came from.
 */
/**
 * Another map on screen, as a task that compares two files needs it.
 *
 * Everything the mount needs and the reader's own name for the panel, which is
 * what the figure is labelled with. Assembled on the main thread, because that
 * is the only side that knows what a deck is.
 */
export interface PeerMap {
  label: string
  uri: string
  source: SourceSpec
  cells?: readonly string[]
  binning?: PairsBinning
  /** The total this map is drawn to, as the reader draws it (§6.5). */
  resample?: ResampleTarget
}

/**
 * A map drawn to another total (§6.5), as a mount in this worker is told it.
 *
 * The same spec the reader was given, so the two mounts draw the same pixels —
 * the draw is seeded, and the seed and total are all it depends on — and the
 * reader's census of the map, so this mount need not walk every pixel again to
 * learn what the reader already counted.
 */
export interface ResampleTarget {
  contacts: number
  seed?: number
  alpha?: number
  census?: Census
}

export interface TaskInputs {
  features?: Record<string, FeatureSet>
  pairs?: Record<string, PairSet>
  /** Bin vectors of chosen tracks, where a task correlates or ranks by them. */
  vectors?: Record<string, Float32Array>
  /**
   * What each chosen entry is **called**, by entry id.
   *
   * A task receives ids, because an id is what survives a rename and what the
   * form stored — and an id is `a1`. A correlation heatmap whose axes read
   * `a1, a2, a3` is a figure nobody can read, and it was one: the labels are the
   * reader's own names for their files, and the runner is the only side that has
   * them. So they travel with the inputs.
   *
   * By id and not by parameter key, unlike everything else here: a task that
   * takes several tracks reads their ids back with `listParam` and looks each of
   * them up, which is the direction the lookup is actually needed in.
   */
  labels?: Record<string, string>
  /**
   * The assembly, as name to length.
   *
   * Carried because the annotations worker does not have one. It holds bigWig
   * handles and parsed feature sets, and neither is an assembly: a `FeatureSet`
   * knows which sequences it mentions and not how long they are. A window
   * clamped to nothing runs off the end of a chromosome, which for a metaplot
   * means a feature near a telomere quietly contributing signal from past the
   * sequence — so the runner sends what it already knows rather than each task
   * inventing a way to find out.
   */
  contigLengths?: Record<string, number>
  /**
   * The four orientation-resolved decay curves of an imported `.pairs` (§3.7).
   *
   * Handed in rather than read, because they cannot be read here: the records
   * they were counted from are gone by the time any task runs, and what the
   * worker has mounted is the pixel table they were binned into. This is the one
   * input in this list that is a *measurement* rather than a thing to measure,
   * and it is here for the reason the rest are — it lives on the main thread and
   * the task that draws it runs on this one.
   */
  orientation?: OrientationSummary
  /**
   * Files handed to the task's `file` parameters, by parameter key (§18.8).
   *
   * A dropped `File`, or a row picked out of a connected place with whatever
   * authorises it — the same `SourceSpec` a map is opened from, and structured
   * cloneable for the same reason: a `File` crosses by reference and its bytes
   * are read here, never on the main thread (§11). The parameter's own value is
   * the file's name, for the record; this is where its bytes are.
   */
  sources?: Record<string, SourceSpec>
  /**
   * The other maps of a deck, for the one task whose unit is a pair of files.
   *
   * Empty or absent everywhere else. This worker mounts **one** file (§18.3) and
   * that is the right shape for every other task in the catalogue: an analysis
   * is a measurement of a picture. A reproducibility coefficient is a
   * measurement of two, and rather than giving the worker a second permanent
   * mount it is handed the addresses and opens each in turn, for one sequence at
   * a time, closing as it goes.
   */
  peers?: PeerMap[]
  /**
   * What the reader calls the map this job measures (§16.10), for a task that
   * names it beside its peers — the matrix, the tables and the lines of a
   * reproducibility run name every map, this one included.
   */
  mapLabel?: string
  /** The view's own block, when it was small enough to be worth copying. */
  block?: BlockInput
  /**
   * Results of the tasks in `requires`, already computed by the runner.
   *
   * Keyed by task id. This is what makes a composite a composite: the saddle
   * asks for eigenvectors and expected, gets them, and never learns whether they
   * were freshly computed or reused from a cache whose parameters and framing
   * happened to match (§18.2).
   */
  upstream?: Record<string, TaskResult>
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface AnalysisResultMap {
  open: { nBins: number; binsize: number }
  run: TaskResult
  correlate: CorrelationField
  smooth: SmoothedField
  cancel: null
  close: null
}

export type AnalysisRequestKind = keyof AnalysisResultMap

export type AnalysisRequest =
  // Lazy, and the laziness is the point: nothing mounts until the first task
  // that needs a mount, so opening the panel to read the list of tasks costs no
  // I/O and no wasm instance.
  | {
      id: number
      kind: 'open'
      uri: string
      source: SourceSpec
      /**
       * The cells to sum, for a single-cell container (§3.8).
       *
       * Absent for every other file, and absent means *all of them* — which is
       * what an scool with nothing ticked draws. It is carried because this
       * worker mounts the file independently of the reader's: without it, a task
       * run over two selected cells would silently measure the pseudo-bulk.
       */
      cells?: readonly string[]
      /**
       * How to bin a `.pairs`, where this map was imported from one (§3.7).
       *
       * The reader has already chosen it; this mount is the *second* one and
       * must not ask again. Without it every task on an imported map failed at
       * the mount with a refusal the reader had already answered.
       */
      binning?: PairsBinning
      /**
       * The total the reader drew this map to (§6.5). Absent is the file as
       * stored. Every task reads the drawn map, so a task run at a matched depth
       * measures that depth and not the file's.
       */
      resample?: ResampleTarget
    }
  | {
      id: number
      kind: 'run'
      task: string
      params: Params
      framing: AnalysisFraming
      inputs: TaskInputs
    }
  /**
   * The correlation of a square the **view already holds**, for the map's own
   * correlation toggle rather than for a task.
   *
   * Beside `run` rather than inside it, and that is not a shortcut. A task is a
   * measurement of a *file*: it names a mount, it carries a framing and a set of
   * parameters, and it comes back as a `TaskResult` with provenance attached
   * because somebody is going to put it in a paper. This is a different kind of
   * thing — one array in, one array out, over cells that are on screen at this
   * moment — and routing it through the catalogue would mean mounting the file a
   * second time to compute something that needs nothing from it.
   *
   * It is here rather than on the reader's thread because it is the one piece of
   * arithmetic in the viewer that is **cubic**: measured at 2.8 s for a 929-bin
   * square and eight times that per doubling, so four minutes at the block cap.
   * That is exactly the shape §18.3 gives this thread — the work measured in
   * seconds, so that the thread answering frames never queues behind it.
   *
   * `values` is copied rather than transferred, for {@link BlockInput}'s reason:
   * transferring would neuter the array the heatmap is drawing from.
   */
  | { id: number; kind: 'correlate'; values: Float32Array; n: number }
  /**
   * The adaptive despeckle of a block the **view already holds**, for the map's
   * `adaptive` smoothing setting.
   *
   * Beside `correlate` and for its reasons. It is not a `run`, because a task is
   * a measurement of a *file* with a mount, a framing and provenance, and this is
   * one block's cells going out and coming back. And it is off the reader's
   * thread because it is the one step of `render/derive.ts` that reads the block
   * twice — 1.5 s at 4 M cells and 7.4 s at the 16 M cap, against the ~20 ms a
   * fixed radius costs, which is exactly the shape §18.3 gives this thread.
   *
   * The arrays are copied rather than transferred, for the same reason
   * `correlate`'s are: transferring would neuter the arrays the heatmap is
   * drawing from while it waits for the answer.
   */
  | {
      id: number
      kind: 'smooth'
      values: Float32Array
      counts: Float32Array
      over: Float32Array | null
      nrows: number
      ncols: number
      spec: Extract<Smoothing, { kind: 'adaptive' }>
    }
  // Cooperative, exactly as the reader's is: the worker checks between pixel
  // chunks, so a scan stops at the next chunk boundary rather than being killed
  // mid-write.
  | { id: number; kind: 'cancel'; target: number }
  | { id: number; kind: 'close' }

export type AnalysisRequestOf<K extends AnalysisRequestKind> = Omit<
  Extract<AnalysisRequest, { kind: K }>,
  'id'
>

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/**
 * Progress, with a `note` that is used rather than decorative.
 *
 * A composite runs several things in sequence and the honest answer to "why is
 * this taking so long" is which of them is running — *expected → correlation →
 * eigenvectors*. The reader's protocol already carries an optional note for the
 * same reason; here it is the norm.
 */
export type AnalysisResponse =
  | { type: 'result'; id: number; kind: AnalysisRequestKind; payload: unknown }
  | { type: 'error'; id: number; error: SerialisedError }
  | { type: 'progress'; id: number; done: number; total: number; note?: string }
  | { type: 'busy'; fraction: number }

export type AnalysisProgressHandler = (done: number, total: number, note?: string) => void

/**
 * The typed arrays in a result, so `postMessage` moves them instead of copying.
 *
 * A pileup is small, but a per-bin profile over a metagenome is megabytes and a
 * per-feature table can be tens of thousands of rows. Enumerated by walking the
 * outputs rather than by a deep scan, for the reason `worker/protocol.ts`'s own
 * `transfersFor` gives: a generic walk over an arbitrary object finds buffers
 * nobody meant to give away, and a transferred buffer the sender still holds is
 * a neutered array and a bug hundreds of frames from its cause.
 */
export function analysisTransfers(payload: unknown): Transferable[] {
  const out: Transferable[] = []
  const result = payload as TaskResult | null
  if (result === null || typeof result !== 'object') return out
  const take = (view: ArrayBufferView | undefined): void => {
    if (view === undefined) return
    const buffer = view.buffer
    // `SharedArrayBuffer` is not transferable, and a buffer offered twice throws
    // rather than being ignored — a profile and its own extent can share one.
    if (buffer instanceof ArrayBuffer && !out.includes(buffer)) out.push(buffer)
  }
  // A correlation field, which is not a `TaskResult` and has no `outputs`. Safe
  // to transfer where the *request's* array was not: this one is allocated by
  // the job and nothing on the far side keeps a reference, so moving it saves a
  // copy of up to 64 MB at the bin cap instead of neutering a block being drawn.
  const field = payload as Partial<CorrelationField> & Partial<SmoothedField>
  if (field.values instanceof Float32Array) {
    take(field.values)
    // A smoothing carries a second field beside the first — the baseline averaged
    // over the same windows — allocated by the job on the same terms, so it moves
    // rather than being copied too.
    if (field.over instanceof Float32Array) take(field.over)
    return out
  }
  if (!Array.isArray(result.outputs)) return out
  for (const output of result.outputs) {
    switch (output.kind) {
      case 'profile':
        take(output.values)
        break
      case 'matrix':
        take(output.values)
        break
      case 'curve':
        for (const series of output.series) {
          take(series.x)
          take(series.y)
          take(series.low)
          take(series.high)
        }
        break
      case 'intervals': {
        const data = output.payload.data as unknown as Record<string, unknown>
        for (const value of Object.values(data)) {
          if (ArrayBuffer.isView(value)) take(value)
        }
        break
      }
      case 'table':
        break
    }
  }
  return out
}
