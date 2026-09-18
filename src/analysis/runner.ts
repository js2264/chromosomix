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
import type { OrientationSummary, PairsBinning, SourceSpec } from '../worker/protocol'
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
import { LEAD_MAP, type MapId } from '../annotations/placement'
import type { AnnotationClient } from '../annotations/worker/client'
import { AnalysisClient } from './worker/client'
import { provisionalProvenance, runDraft } from './record'
import { endAction, logAction, type ActionDraft, type ActionOutcome } from '../state/actions'
import { fileLabel } from '../ui/labels'
import {
  BLOCK_COPY_LIMIT_BYTES,
  type BlockInput,
  type PeerMap,
  type TaskInputs,
} from './worker/protocol'

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
  | {
      status: 'running'
      done: number
      total: number
      note: string
      startedAt: number
      /** `3 of 5 · rep3.cool` while a batch is being worked through. */
      batch?: { at: number; of: number; label: string }
    }
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
  source(): {
    uri: string
    source: SourceSpec
    cells?: readonly string[]
    binning?: PairsBinning
    orientation?: OrientationSummary
  } | null
  /** Which map a plain Run files its results against — the star (§18.2). */
  targetMap?(): MapId
  /** Every map on screen, in reading order, for {@link AnalysisRunner.runAll}. */
  allTargets?(): readonly RunTarget[]
  /** The same, once every map still opening has answered; see {@link AnalysisRunner.readyTargets}. */
  allTargetsReady?(): Promise<readonly RunTarget[]>
  /** How many maps a batch will end up covering, ready or not. */
  targetCount?(): number
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
  /**
   * What a chosen entry is called, for the outputs that name one.
   *
   * The store's, and the reader's: an entry id is `a1`, and a figure whose axes
   * are ids is a figure that has to be decoded against a panel. Optional
   * because a host that cannot answer leaves the ids, which is what they always
   * were rather than a regression.
   */
  label?(entryId: string): string | undefined
  /**
   * A run produced a result, and the map it was measured from.
   *
   * The map is the third argument rather than something the host reads back off
   * the star, and a batch is why: five results arrive one after another and the
   * star has not moved between them, so a host asking "which map is starred"
   * would file all five on whichever one it is. What a task produces belongs to
   * the picture it read.
   */
  finished(task: AnalysisTask, result: TaskResult, target: RunTarget): void
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

/**
 * The map one job runs against, taken when Run was pressed.
 *
 * Held on the job rather than read from the host at dispatch, which is what
 * makes a **batch** possible at all: five jobs queued against five files are
 * five targets, and a host answering "the starred map" would give all five
 * whichever map the star was on when the last of them reached the worker. It
 * also removes a race the old shape had to fail on by name — *the open file
 * changed while this job was queued* — because there is no longer a moving
 * answer for it to disagree with.
 */
/**
 * The key a result is filed under.
 *
 * A NUL between the two halves rather than a slash or a colon: a `MapId` is a
 * generated identifier and a task id is from a fixed catalogue, but neither is
 * validated against a separator, and a key collision here shows up as one map's
 * numbers under another map's tab.
 */
export function resultKey(map: MapId, taskId: string): string {
  return `${map}\u0000${taskId}`
}

/**
 * How many runs of one task on one map are kept, the current one included.
 *
 * Eight, which is a parameter sweep and not an archive. Each held result is its
 * own typed arrays — a pileup, a saddle, a per-bin profile — so this is a memory
 * budget as much as a convenience, and the failure it guards against is a tab
 * that grows all afternoon and is blamed on the file. Eight is enough for the
 * thing people actually do, which is to change one number two or three times and
 * then want the one before last.
 */
export const RUN_HISTORY = 8

/**
 * What the analysis worker's mount is identified by.
 *
 * The file, and — for a single-cell container — the cells it is summing. Two
 * runs of the same task over the same scool with different cells ticked are two
 * different measurements, and a mount cached on the URI alone would give the
 * second the first one's answer with nothing on screen to say so.
 */
function mountKey(uri: string, cells?: readonly string[], binning?: PairsBinning): string {
  const base =
    cells === undefined || cells.length === 0 ? uri : `${uri}\u0000${cells.join('\u0000')}`
  // The base resolution and the rung count, because an imported map at 1 kb and
  // the same file at 10 kb are two maps behind one uri (§3.7) — and a mount kept
  // for the uri alone would answer a task about the second with the first.
  return binning === undefined ? base : `${base}\u0000${binning.base}:${binning.rungs}`
}

/**
 * What a console line calls the map a job ran on.
 *
 * Through `fileLabel` whichever kind of label the target carries: a deck names
 * its maps and a lone map is named by its own URI, and a column of full paths
 * would push the command — the thing the panel is for — off the right of the
 * row. A name that is not a path comes back unchanged, so the deck's own naming
 * (§16.10) is what a reader sees there.
 */
function targetLabel(target: RunTarget): string {
  return fileLabel(target.label)
}

/** The half of a draft that an outcome may replace. */
function draftFields(draft: ActionDraft): Pick<ActionOutcome, 'line' | 'notes' | 'detail'> {
  return { line: draft.line, notes: draft.notes ?? [], detail: draft.detail ?? [] }
}

export interface RunTarget {
  /** Which map, for filing what the run produces (`annotations/placement.ts`). */
  map: MapId
  uri: string
  /**
   * How the analysis worker would mount this file, where there is one to mount.
   *
   * Absent in a session with no contact map, which is not a broken target: the
   * three track tasks (§18.3) read the loaded tracks in the *other* worker and
   * this one is never opened for them ({@link AnalysisRunner.mount}). A map task
   * that reaches a target without one fails by name, which is the honest answer
   * — and the one this used to give as "nothing is open", to every track task in
   * a 1D browser session.
   */
  source?: SourceSpec
  /**
   * The cells this map is summing, where it is a single-cell container (§3.8).
   *
   * Absent everywhere else, and absent means *all of them*. It is part of the
   * target rather than of the source because it is a property of the *view* —
   * the same file with two cells ticked and with four thousand is two different
   * experiments, and a task measures the one on screen.
   */
  cells?: readonly string[]
  /**
   * How this map was binned, where it was imported from a `.pairs` (§3.7).
   *
   * On the target rather than folded into the source because it is a property of
   * the *map* rather than of the bytes: the same file at two base resolutions is
   * two maps, and a mount keyed on the uri alone would answer the second with
   * the first. See {@link mountKey}.
   */
  binning?: PairsBinning
  /**
   * The orientation curves that map's import counted, where it had strands.
   *
   * Per target for the same reason `binning` is: a deck can hold two imported
   * files, and a curve measured on one is not a fact about the other.
   */
  orientation?: OrientationSummary
  /** What to call it while a batch is being worked through. */
  label: string
}

interface Job {
  task: AnalysisTask
  params: Params
  /** Taken when Run was pressed, not when the worker got to it (§18.4). */
  framing: AnalysisFraming
  target: RunTarget
  /** Where this job sits in a batch, or `null` for a run of one. */
  batch: { at: number; of: number } | null
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
  /**
   * Finished results, keyed by **map and task** rather than by task alone.
   *
   * Two things depend on the map being in the key, and the second is a defect
   * that was live.
   *
   * A deck's batch (`runAll`) produces one result per panel, and a reader
   * comparing four libraries wants all four — on their own tabs, or overlaid in
   * one figure. Keyed by task alone, the fourth overwrote the third overwrote
   * the second, and what a batch left behind was one plot and four synthetic
   * tracks: the tracks were filed per map and the *figures* were not.
   *
   * And this map is also the composite cache (§18.2): a saddle asks for
   * eigenvectors and takes them from here when the recipe matches. A recipe is
   * params plus framing, and **a batch shares one framing across every target**
   * — it is taken once, when Run is pressed. So the reuse test could not see
   * that the cached eigenvectors were measured on another file, and a saddle run
   * over a deck drew panel B's compartments out of panel A's numbers. Silently,
   * and only for the composites.
   */
  private readonly results = new Map<string, TaskResult>()
  /**
   * The runs **before** the current one, newest first, keyed like the results.
   *
   * A task run twice used to leave one figure: the second result replaced the
   * first in place and the first was gone, along with the parameters that
   * produced it. That is the wrong shape for what people actually do with this
   * catalogue, which is to run a thing, change one number, run it again, and
   * then want the two side by side — or, more often, to discover that the
   * previous answer was the one worth keeping. Nothing about a finished result
   * makes it cheap to recompute: a pileup over forty thousand anchors is a
   * minute of range requests, and a reader who lost it by pressing Run has lost
   * the minute.
   *
   * So the old result is kept rather than dropped. Bounded by
   * {@link RUN_HISTORY}, because these hold typed arrays and an afternoon of
   * parameter sweeps would otherwise be an afternoon of pileups in memory; the
   * oldest falls off the end, which is the one a reader is least likely to want
   * and the one they can most easily produce again.
   *
   * Not persisted, for the reason §18.4 gives about the framing: a result is a
   * record *of a view*, and a history restored against a file that has since
   * been re-binned would be a list of figures that no longer describe anything.
   */
  private readonly history = new Map<string, TaskResult[]>()
  /** The target each stored result was measured on, for labelling the tabs. */
  private readonly resultTargets = new Map<string, RunTarget>()
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

  /**
   * The result for one task on one map; the host's own map when none is named.
   *
   * The default is what every existing caller wants and is why they needed no
   * change: a drawer showing one figure is showing the starred map's.
   */
  resultOf(taskId: string, map?: MapId): TaskResult | null {
    const where = map ?? this.host.targetMap?.() ?? LEAD_MAP
    return this.results.get(resultKey(where, taskId)) ?? null
  }

  /**
   * Every run of this task on one map, newest first — the current one included.
   *
   * What the drawer's *previous run* stepper walks. The current result leads,
   * because that is what is on screen when the drawer opens and a list that made
   * the reader step *forwards* to reach it would be reading itself backwards.
   *
   * An empty list where there is no result at all, so a caller need not tell
   * "never run" from "run once" before it can count.
   */
  runsOf(taskId: string, map?: MapId): TaskResult[] {
    const where = map ?? this.host.targetMap?.() ?? LEAD_MAP
    const key = resultKey(where, taskId)
    const current = this.results.get(key)
    const older = this.history.get(key) ?? []
    return current === undefined ? [...older] : [current, ...older]
  }

  /**
   * Every map this task has a result for, in the order the deck holds them.
   *
   * What the drawer's tabs are built from, and what the combined figure folds.
   * Ordered by the host's target list rather than by when each finished, so the
   * tabs follow the grid and not the queue — a batch reports in reading order
   * but a re-run of one panel would otherwise jump it to the end.
   */
  resultsFor(taskId: string): Array<{ target: RunTarget; result: TaskResult }> {
    const order = this.host.allTargets?.() ?? []
    const seen = new Set<MapId>()
    const out: Array<{ target: RunTarget; result: TaskResult }> = []
    for (const target of order) {
      const result = this.results.get(resultKey(target.map, taskId))
      if (result === undefined) continue
      seen.add(target.map)
      out.push({ target, result })
    }
    // A result whose map has since left the deck is still a result, and losing
    // it when a panel is closed would throw away a computation the reader is
    // looking at. It goes on the end, labelled by the target it was run against.
    for (const [key, result] of this.results) {
      const target = this.resultTargets.get(key)
      if (target === undefined || seen.has(target.map)) continue
      if (key !== resultKey(target.map, taskId)) continue
      out.push({ target, result })
    }
    return out
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
    this.queueOne(task, params, null)
  }

  /**
   * Run one task against **every map on screen**, one after another.
   *
   * The question a deck raises and the star only half answers: four replicates
   * are open because they are being compared, and the comparison is four
   * insulation tracks rather than one. Pressing Run four times means moving the
   * star four times and remembering which of them has been done — bookkeeping
   * the reader should not be doing for a machine that can count.
   *
   * **One job per map, queued, not four at once.** The worker mounts one file at
   * a time, so the queue is what the deck's own memory budget already assumes;
   * running them in parallel would be four h5wasm instances and four dense
   * blocks live at the moment the tab can least afford it. Each result is filed
   * against the map it was measured from, so what a batch leaves behind is a
   * track per panel, each on its own picture, and each cancellable at the point
   * it has reached.
   *
   * The targets are the caller's, in the order they should run: the session
   * hands the lead first and then the deck in reading order, which is what a
   * reader looking at the grid would expect the progress to follow.
   */
  runAll(task: AnalysisTask, params: Params, targets: readonly RunTarget[]): void {
    if (targets.length === 0) return
    if (targets.length === 1) {
      this.queueOne(task, params, null, targets[0])
      return
    }
    // Cleared first, so a batch does not queue behind the single run of the same
    // task a reader pressed a moment ago and then report *its* progress as the
    // first of five.
    this.cancel(task.id)
    targets.forEach((target, at) => {
      this.queueOne(task, params, { at, of: targets.length }, target)
    })
  }

  private queueOne(
    task: AnalysisTask,
    params: Params,
    batch: { at: number; of: number } | null,
    target?: RunTarget,
  ): void {
    if (this.destroyed) return
    const context = this.host.context()
    if (context === null) {
      this.refuse(task, batch, 'nothing is open')
      return
    }
    // A task in the other venue reads the loaded tracks and never touches the
    // matrix, so it runs in a session that has no matrix at all — a 1D browser
    // (§5.8), where the reader has the bigWigs and not the map. It still needs a
    // framing, because a result is a record and a record names what it was of
    // (§18.4); what it names there is the assembly rather than a block.
    const framing =
      context.framing ?? (task.venue === 'annotations' ? tracksFraming(context) : null)
    if (framing === null) {
      this.refuse(task, batch, 'this view has no contact map to run against')
      return
    }
    const where = target ?? this.hostTarget(framing)
    // A second press while the same task is already on the worker is a reader
    // wondering whether the first one registered, not a request for two runs of
    // it. A press while it is still *queued* is a change of mind about the
    // parameters, so the recipe is replaced where it stands — moving it to the
    // back of the queue would punish the correction.
    //
    // **Per map, not per task**, since a batch is one task queued five times:
    // collapsing on the id alone would leave a five-map batch running once.
    if (batch === null) {
      if (this.current?.task.id === task.id && this.current.target.map === where.map) return
      const waiting = this.queue.find(
        (job) => job.task.id === task.id && job.target.map === where.map,
      )
      if (waiting !== undefined) {
        waiting.params = params
        waiting.framing = framing
        return
      }
    }
    this.queue.push({
      task,
      params,
      framing,
      target: where,
      batch,
      cancelled: false,
      running: null,
    })
    this.setState(task.id, { status: 'queued' })
    this.pump()
  }

  /**
   * Every map a batch would run on, in the order it would run them.
   *
   * Asked of the host on every call rather than held: a deck gains and loses
   * maps while a drawer is open, and the button that offers to run on all of
   * them has to be counting the ones that are there.
   */
  targets(): readonly RunTarget[] {
    return this.host.allTargets?.() ?? []
  }

  /**
   * Every map a batch will run on, once the ones still opening have answered.
   *
   * {@link targets} is the synchronous reading and is what the drawer prices,
   * orders results by and finds the star in. It is the wrong list to *run* from:
   * a companion opens to draw a picture, and the two tables an analysis needs
   * are a further pair of reads it only makes when starred or batched — so on a
   * freshly opened deck the first press of **Run on all maps** found some of
   * them missing and quietly ran on the rest. Pressing again worked, which made
   * a timing question look like a question about the files.
   *
   * Falls back to the synchronous list where a host has no answer, which is
   * every session with no deck: there is one map, it is open, and there is
   * nothing to wait for.
   */
  async readyTargets(): Promise<readonly RunTarget[]> {
    return (await this.host.allTargetsReady?.()) ?? this.targets()
  }

  /**
   * How many maps a batch will end up covering — what the button counts.
   *
   * Not `targets().length`: a deck of four with one still opening offered "run
   * on all 3 maps" and then ran four. Counting the grid is the honest number,
   * because {@link readyTargets} waits for every cell in it.
   */
  targetCount(): number {
    return this.host.targetCount?.() ?? this.targets().length
  }

  /**
   * Which of {@link targets} a plain Run goes to — the starred map (§18.2).
   *
   * `null` where the session names no such map, which is every session without
   * a deck: there is one map, a plain Run goes to it, and naming it would be
   * telling a reader which of one thing was chosen. The drawer's Run button
   * reads this to say *what it is about to measure*, which on a deck of five is
   * the one thing the word "run" does not say.
   */
  target(): RunTarget | null {
    const map = this.host.targetMap?.()
    if (map === undefined) return null
    return this.targets().find((target) => target.map === map) ?? null
  }

  /**
   * The one map a plain Run goes to: whatever the session says is current.
   *
   * A session with nothing to *mount* still has a target, and that is the whole
   * of what a track task needed: the framing is what it is a measurement of, and
   * a genome browser has one of those without having a contact map. Where the
   * host does answer with a file — which is every session with a map, and the
   * starred one in a deck — that file is what the target names.
   */
  private hostTarget(framing: AnalysisFraming): RunTarget {
    const source = this.host.source()
    return {
      map: this.host.targetMap?.() ?? LEAD_MAP,
      uri: source?.uri ?? framing.uri,
      ...(source === null ? {} : { source: source.source }),
      // Carried, not dropped: this is the target a plain Run builds, so a cell
      // set lost here is lost for every single-map run — which is all of them
      // outside a batch (§3.8).
      ...(source?.cells === undefined ? {} : { cells: source.cells }),
      label: framing.uri,
    }
  }

  /**
   * Call off a queued or running job.
   *
   * Cooperative for the running one: the worker checks between chunks, so the
   * job stops at the next check and its `AbortError` arrives here as a
   * cancellation rather than as a failure. A job that has already finished is
   * left alone — cancelling a result would be deleting it.
   *
   * That is the analysis worker. A step in the **annotations** venue is not
   * stoppable mid-flight at all — `runStep` says why — so the guarantee there
   * is narrower and is kept on this side instead: whatever the step goes on to
   * compute, the row ends `cancelled` and nothing it produced is adopted
   * (`execute`, at the check after `runStep`). Both halves are needed. Setting
   * the flag without that check is what let a cancelled run finish as `done`
   * with its lanes on the panel.
   */
  cancel(taskId: string): void {
    // **Every** queued job for this task, not the first: a batch is one task
    // queued once per map, and dropping one of five would stop the map in flight
    // and start the next — a Stop that looks like it did nothing, twice.
    let dropped = 0
    for (let at = this.queue.length - 1; at >= 0; at--) {
      if (this.queue[at].task.id !== taskId) continue
      this.queue.splice(at, 1)
      dropped++
    }
    const job = this.current
    if (job === null || job.task.id !== taskId) {
      // Nothing was running: what was cancelled is what was waiting. A task with
      // neither is a press on a row whose job has already finished, and
      // cancelling a result would be deleting it.
      if (dropped > 0) this.setState(taskId, { status: 'cancelled' })
      return
    }
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

  /**
   * The batch tail of a running state, or nothing for a run of one.
   *
   * Attached to every `running` state rather than to the first, because a batch
   * is only legible while it is *in progress*: a reader who sees "opening the
   * file" with no idea it is the fourth of five has no way to tell a long job
   * from a stuck one.
   */
  private batchOf(job: Job): { batch: { at: number; of: number; label: string } } | object {
    return job.batch === null
      ? {}
      : { batch: { at: job.batch.at, of: job.batch.of, label: job.target.label } }
  }

  private async execute(job: Job): Promise<void> {
    const startedAt = performance.now()
    let step: PlanStep | null = null
    // **One console line per job**, written here and not where Run was pressed
    // (§23). That is what makes *run on all maps* six lines rather than one: the
    // button queues six jobs, and this is the place that knows a job from a
    // press. It is also the only place that sees a run that never reached a
    // result — a failure, or a Stop — which is exactly the run whose parameters
    // a reader most wants back.
    const recorded = this.recordStart(job)
    let outcome: ActionOutcome | null = null
    this.setState(job.task.id, {
      status: 'running',
      done: 0,
      total: 0,
      note: 'starting',
      startedAt,
      ...this.batchOf(job),
    })
    try {
      const chain = this.plan(job.task, job.params)
      const client = this.ensureClient()
      // Mounted only for a chain that reads the matrix. A track-only chain has
      // no file for the analysis worker to open — and opening one anyway would
      // be a wasm instance and a range cache for a job that will not ask them a
      // question.
      if (chain.some((step) => step.task.venue !== 'annotations')) {
        await this.mount(job, client, startedAt)
      }

      const upstream: Record<string, TaskResult> = {}
      for (let at = 0; at < chain.length; at++) {
        step = chain[at]
        if (job.cancelled) throw abortError()
        const leaf = step.task.id === job.task.id

        // A cached upstream whose recipe matches is the answer, and the task
        // below never learns whether it was computed now or ten minutes ago
        // (§18.2). The leaf is never taken from the cache: pressing Run means
        // run it.
        const cached = this.results.get(resultKey(job.target.map, step.task.id))
        if (
          !leaf &&
          cached !== undefined &&
          sameRecipe(cached.provenance, { params: step.params, framing: job.framing })
        ) {
          upstream[step.task.id] = cached
          continue
        }

        const result = await this.runStep(job, client, step, chain, at, upstream, startedAt)
        // Stopped *while this step was in flight*, which the check at the top of
        // the loop cannot see: it runs before the step, and a Stop pressed after
        // that is only readable once the step settles. Without this line the
        // leaf branch below ran anyway — `setState('done')` and
        // `this.host.finished(...)` — so a cancelled run adopted its lanes onto
        // the Annotations panel and its row said `running` until the moment it
        // said `done`, never `cancelled`. The whole of what the panel's Stop
        // promises is that the answer is not taken, so the refusal belongs here
        // rather than only in the worker: the **annotations** venue has no
        // cancel that reaches the work at all (see `runStep`), and even the
        // analysis worker's `AbortError` can lose the race with the result it
        // was meant to pre-empt.
        if (job.cancelled) throw abortError()
        const key = resultKey(job.target.map, step.task.id)
        // The result this one replaces goes to the front of the history, so
        // *previous* means the run before this one on this map — and a
        // composite's reused upstream step is filed the same way, since it is
        // as much a result as the leaf.
        const previous = this.results.get(key)
        if (previous !== undefined && previous !== result) {
          const kept = this.history.get(key) ?? []
          kept.unshift(previous)
          this.history.set(key, kept.slice(0, RUN_HISTORY))
        }
        this.results.set(key, result)
        this.resultTargets.set(key, job.target)
        if (leaf) {
          this.setState(step.task.id, {
            status: 'done',
            result,
            // Wall clock from dispatch, which for a composite counts the whole
            // chain including the steps that were reused. `result.ms` is the
            // last step's own time, and is what the drawer prints beside it.
            ms: performance.now() - startedAt,
          })
          this.host.finished(job.task, result, job.target)
          // The result's own provenance replaces the one this job was recorded
          // with: the worker wrote it beside the numbers, so it is the
          // authoritative account of what produced them (see `record.ts`).
          outcome = {
            status: 'ok',
            ms: performance.now() - startedAt,
            ...draftFields(
              runDraft({
                task: job.task,
                provenance: this.recordable(job, result.provenance),
                context: this.host.context(),
                where: targetLabel(job.target),
              }),
            ),
          }
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
      outcome = cancelled
        ? { status: 'cancelled' }
        : { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    } finally {
      job.running = null
      // The fallback covers a chain that ended without reaching its own leaf,
      // which nothing adopts and which is a cancel from where the reader sits.
      // A line left saying `running` would spin for the life of the tab and come
      // back `interrupted` after a reload, which would be this bookkeeping
      // blaming the browser.
      endAction(recorded, outcome ?? { status: 'cancelled' })
    }
  }

  /**
   * A press of Run that never became a job.
   *
   * Both refusals above are about the **session** rather than about the target —
   * there is nothing open, or the view has no map — so the console line says so
   * once however many maps the batch was aimed at: five copies of one fact is
   * five lines a reader has to read before finding out they are the same line.
   *
   * Recorded at all because the console's promise is that every press leaves a
   * line (§23). There is no command on this one and there cannot be: a framing
   * is what a command's `--window` is written from, and the absence of one is
   * the refusal. So it is prose, with the reason on it, which is the answer to
   * "why did nothing happen when I pressed run at two o'clock".
   */
  private refuse(task: AnalysisTask, batch: { at: number; of: number } | null, why: string): void {
    this.setState(task.id, { status: 'failed', message: why })
    if (batch !== null && batch.at > 0) return
    logAction({
      kind: 'run',
      line: `ran ${task.title}`,
      status: 'failed',
      error: why,
    })
  }

  /**
   * Open the console's line for a job that is about to run.
   *
   * The provenance is composed rather than read, because there is no result yet
   * — see `record.ts`. What it costs if the job then fails is a `created:` stamp
   * naming the moment the work started instead of the moment it stopped, which
   * is the more useful of the two on a run that produced nothing.
   */
  private recordStart(job: Job): string {
    const draft = runDraft({
      task: job.task,
      provenance: this.recordable(job, provisionalProvenance(job.task, job.params, job.framing)),
      context: this.host.context(),
      where: targetLabel(job.target),
    })
    return logAction({ ...draft, status: 'running' })
  }

  /**
   * The provenance a console line is written from: the job's, naming the file
   * the job actually ran on.
   *
   * **A batch shares one framing across every target** — it is taken once, when
   * Run is pressed, which is what makes a result a record of what the reader was
   * looking at (§18.4) — and an `AnalysisFraming` carries a `uri`. So the second
   * job of a five-map batch is dispatched against `rep2.cool` and carries a
   * framing that says `rep1.cool`, and the worker echoes that framing into the
   * result it returns.
   *
   * Invisible in the drawer, which prints `framing.label` and never the URI. Not
   * invisible here: this is the one surface that turns a provenance into a
   * **command**, and a command naming the wrong file is a reader running the
   * wrong experiment in a shell. So the line is written from the target's file,
   * and the *whole* line is — the `#` provenance block above the command as well
   * as the command itself — because a row that quoted two files would be worse
   * than either.
   *
   * Deliberately not written back into `job.framing` or into the result. That
   * framing is compared by `sameRecipe` and by the drawer's staleness check,
   * which is about *the view having moved* rather than about which file is on
   * screen, and changing it would mark every companion's result stale whenever
   * the star is elsewhere — a correction to §18.4's machinery, not to a console.
   */
  private recordable(job: Job, provenance: Provenance): Provenance {
    const uri = job.target.uri
    if (uri === '' || uri === provenance.framing.uri) return provenance
    return { ...provenance, framing: { ...provenance.framing, uri } }
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
    // The job's own target, not the host's answer now: a batch is five jobs
    // against five files, and asking the session which map is current as each
    // reaches the worker would run all five against whichever one it had drifted
    // to. It also retires a failure this used to have to invent — *the open file
    // changed while this job was queued* — since there is no moving answer left
    // for a job to disagree with.
    const source = job.target
    // A target with no file behind it: a session browsing a genome, reached by a
    // task that reads the matrix. Said by name and in the task's own terms,
    // because the reader's way out is to open a cooler — which is a different
    // sentence from the one the queue used to give ("nothing is open") for a
    // session that plainly had a genome and nine tracks in it.
    if (source.source === undefined) {
      throw new Error(
        `${job.task.title} reads a contact map, and this session is browsing a genome without one.`,
      )
    }
    // Keyed on the cell set as well as the file: an scool re-ticked between two
    // runs is the same URI and a different map, and a mount kept for the name
    // alone would answer the second question with the first one's cells.
    const key = mountKey(source.uri, source.cells, source.binning)
    if (this.mounted === key) return
    this.setState(job.task.id, {
      status: 'running',
      done: 0,
      total: 0,
      note: 'opening the file',
      startedAt,
      ...this.batchOf(job),
    })
    // Cleared first: an `open` that rejects halfway leaves the worker holding
    // nothing, and a `mounted` still naming the previous file would make the
    // next job skip the open it now needs.
    this.mounted = null
    await client.request<'open'>({
      kind: 'open',
      uri: source.uri,
      source: source.source,
      ...(source.cells === undefined ? {} : { cells: source.cells }),
      ...(source.binning === undefined ? {} : { binning: source.binning }),
    })
    this.mounted = key
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
    this.setState(job.task.id, {
      status: 'running',
      done: 0,
      total: 0,
      note: label(),
      startedAt,
      ...this.batchOf(job),
    })

    const onProgress = (done: number, total: number, note?: string): void => {
      this.setState(
        job.task.id,
        { status: 'running', done, total, note: label(note), startedAt, ...this.batchOf(job) },
        true,
      )
    }
    const payload = {
      kind: 'run' as const,
      task: step.task.id,
      params: step.params,
      framing: job.framing,
      inputs: await this.inputsFor(step, job, upstream),
    }

    let raw: TaskResult
    if (step.task.venue === 'annotations') {
      // The other venue (§18.3), awaited rather than made cancellable — and
      // that is a limitation to be stated, not a property to rely on. The wire
      // for it exists on both sides: `AnnotationClient.cancellable` is generic
      // over every request kind including this one, and the worker keeps the
      // id-keyed `cancelled` set that the BAM reads already check. What is
      // missing is the last hop — the `TrackJobContext` that worker builds
      // stubs `cancelled` and `throwIfCancelled` out, so a cancel delivered
      // there would stop nothing — and a motif scan is a synchronous pass over
      // a whole reference, which does not return to the event loop for the
      // message to be read in the first place. So `job.running` stays null and
      // Stop cannot reach the work. What it does instead is refuse the answer
      // when it arrives, at the guard after `runStep` in `execute`: the row
      // ends `cancelled` and nothing the run produced is adopted. The scan
      // itself is bounded — `annotations.worker.ts` refuses a FASTA over
      // 300 MB — so what is unstoppable here is seconds rather than minutes.
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
    // A normalisation the *view* computes is one no task can reproduce: VC, VC √
    // and ICE are `render/derive.ts`'s arithmetic over a block already read, and
    // nothing in the file carries them. Said here rather than in each of the
    // fifteen runners, because none of them has any business knowing what a
    // score picker is — and said at all because a pileup captioned `ICE` that is
    // really counts is the kind of wrong that ends up in a figure.
    const notes =
      job.framing.normalise === null
        ? raw.notes
        : [
            ...raw.notes,
            `The map is drawn with ${job.framing.normalise.toUpperCase()} normalisation, which is ` +
              'computed from the block after it is read and cannot be asked of the file. These ' +
              'numbers are the underlying counts.',
          ]
    return { ...raw, notes, provenance: { ...raw.provenance, taskVersion: step.task.version } }
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
    job: Job,
    upstream: Record<string, TaskResult>,
  ): Promise<TaskInputs> {
    const framing = job.framing
    const features: Record<string, FeatureSet> = {}
    const pairs: Record<string, PairSet> = {}
    const vectors: Record<string, Float32Array> = {}
    // By **entry id**, and gathered for every entry parameter whatever its kind:
    // what a task wants to write on an axis is the name of the file, and which
    // parameter chose it is not the question.
    const labels: Record<string, string> = {}

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
        const label = this.host.label?.(entryId)
        if (label !== undefined && label !== '') labels[entryId] = label
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
    if (Object.keys(labels).length > 0) inputs.labels = labels
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
    // The job's **own target's**, never the host's answer now: a batch is five
    // jobs against five files, and a curve counted on one import is not a fact
    // about any of the others (`mount` makes the same argument about the source).
    if (job.target.orientation !== undefined) inputs.orientation = job.target.orientation
    // **Every other target, for the one task whose unit is a pair of files.**
    // Taken from the host's list rather than from the job, because the job knows
    // the map it is *about* and this is a question about the ones beside it —
    // and filtered against the job's own target, since a map is not its own peer.
    if (step.task.id === 'hicrep') {
      const peers: PeerMap[] = []
      for (const target of this.host.allTargets?.() ?? []) {
        if (target.map === job.target.map || target.source === undefined) continue
        peers.push({
          label: target.label,
          uri: target.uri,
          source: target.source,
          ...(target.cells === undefined ? {} : { cells: target.cells }),
          ...(target.binning === undefined ? {} : { binning: target.binning }),
        })
      }
      if (peers.length > 0) inputs.peers = peers
    }

    // **Only to the job that is about the map the block came from.**
    //
    // The block on screen belongs to one panel — the starred one — and
    // {@link blockMatches} cannot tell: it compares extents and a bin size, and
    // in a deck every panel is at the same extents at the same bin size, which
    // is the whole point of a deck. So a batch handed the *same* pixels to all
    // five jobs, and five maps came back with one map's answer. Only on the
    // chromosome that happened to be in view, which is the worst shape a bug of
    // this kind can have: every other region was read per file and correct, so
    // the numbers agreed with themselves everywhere a reader would think to
    // check.
    const block = this.hostBlockFor(job)
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

  /**
   * The block on screen, when it is a picture of *this job's* map.
   *
   * The host has one block to offer and it is whichever panel the star is on
   * (`app/Session.ts`), so lending it to a job about another map is lending one
   * file's pixels to a measurement of another's. `null` everywhere else, which
   * costs that job a read it would have made anyway before decks existed — the
   * worker's second mount is exactly for this.
   */
  private hostBlockFor(job: Job): BlockInput | null {
    const host = this.host.targetMap?.() ?? LEAD_MAP
    return job.target.map === host ? this.host.block() : null
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

/**
 * The framing a track-only run is a record of.
 *
 * There is no block, so the extents are empty and the bin size is zero — and
 * that is the honest reading rather than a placeholder: the numbers came from
 * the tracks, over the assembly named here, and no region of any matrix was
 * involved. A task in this venue never reads any of these fields; what reads
 * them is the provenance line above an export, which should say so.
 */
function tracksFraming(context: AnalysisContext): AnalysisFraming {
  return {
    uri: context.uri,
    rows: [0, 0],
    cols: [0, 0],
    binsize: context.binsize,
    binsPerCell: 1,
    balance: false,
    value: 'count',
    normalise: null,
    level: 'bin',
    // The file's name rather than its address: a browser session is routinely
    // opened from a signed S3 URL, and the whole of one in a heading pushes the
    // rest of the line off the drawer and off a console row. What the uri is
    // wanted for is `# file:`, which every provenance block already carries.
    label: `${fileLabel(context.uri)} · loaded tracks, no contact map`,
  }
}
