/**
 * Everything the Analysis feature is, for one open file, in one object.
 *
 * A `Session` already runs to three and a half thousand lines and holds a
 * reader, an annotations worker, a picker, a breadcrumb, four panel hosts and
 * whichever of six views is mounted. The analysis surfaces are a fifth thing
 * with a lifetime of their own — they are created with a file and destroyed with
 * it, they hold a worker, and none of the rest of the session needs to know how
 * they are joined up. So they are joined up here, and `Session` sees three
 * elements and a boolean.
 *
 * What this module actually does is close the loop §18 describes but no single
 * piece of it can: the runner produces a `TaskResult`, and a result that is one
 * value per bin has to *become a lane*. That is three steps in three different
 * subsystems — an entry in the `AnnotationStore`, a bin vector registered with
 * the annotations worker so `sample` can answer for it, and the values its
 * exports are written from, for the Tracks card's row to ask for — and this is
 * the only place that knows all three exist.
 *
 * The values themselves are kept here rather than in the store, and that is not
 * an oversight. An `AnnotationEntry` is persisted to session storage and carried
 * in an exported session; a megabyte of `Float32Array` is neither of those
 * things (§18.5). What the entry carries is the *recipe*, and what this map
 * carries is the answer for as long as the tab is open — which is exactly as
 * long as an export could be asked for.
 *
 * "As long as the tab is open" is not the same as "as long as this object
 * lives", and {@link AnalysisWorkspace.carry} is the difference. A workspace is
 * built with a file and destroyed with it, and **changing the resolution of an
 * `.mcool` destroys one**: the same file at another level is a fresh open, with
 * a new store, a new annotations worker and a new workspace around it. Every
 * dropped track already survives that (`Session.carry`), and until this a
 * computed one did not — a reader who ran insulation at 1 kb and looked at the
 * same region at 5 kb found its synthetic tracks gone, having lost numbers the
 * tab was still holding for no reason other than which object held them.
 */

import type { AnnotationClient } from '../annotations/worker/client'
import type { BinVector, BinVectorContig } from '../annotations/worker/binVector'
import { LEAD_MAP, type MapId } from '../annotations/placement'
import { defaultStyle, emptyPlacement } from '../annotations/types'
import type { Placement } from '../annotations/types'
import type { AnnotationEntry, ComputedSource } from '../annotations/types'
import type { TrackSampleSet } from '../annotations/types'
import type { AnnotationStore } from '../annotations/store'
import type { GroupSettings } from '../annotations/groups'
import { fmt } from '../ui/dom'
import { chooseSaveTarget, downloadBlob, exportBaseName, fileStamp } from '../ui/export'
import { AnalysisDrawer } from '../ui/AnalysisDrawer'
import { AnalysisPanelCard } from '../ui/AnalysisPanelCard'
import { groupNameOn, syntheticEntry, syntheticId, type SyntheticFormat } from '../ui/synthetic'
import type { SourceSpec } from '../worker/protocol'
import { gridAt } from './context'
import { adoptCalledSet, calledPayloadOf, isCalledSet } from './surfaces'
import { calledSetFields } from '../ui/calledSurfaces'
import { TASKS, tasksFor } from './registry'
import { declaredOrigins } from './tasks/oriter'
import { AnalysisRunner, type RunnerHost, type RunTarget } from './runner'
import { rememberParams } from './memory'
import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  IntervalsOutput,
  ProfileOutput,
  Provenance,
  TableOutput,
  TaskResult,
} from './types'
import type { BlockInput } from './worker/protocol'
import { profileToBedGraph, spansToBedGraph, type BedGraphContig } from './write/bedgraph'
import { writeBigWig } from './write/bigwig'
import { outputToTsv, spansToTsv, tsvName } from './write/tsv'
import { formatIntervals } from '../annotations/export'
import { g3dSummary, writeBed3d } from '../annotations/g3d'
import { VERSION } from '../version'
import { TRACK_OP_LABELS, combineSamples, type TrackOp } from '../annotations/derived'

/** What the workspace needs from the session around it. */
export interface AnalysisWorkspaceHost {
  /**
   * How the analysis worker should mount the file; `null` before anything is open.
   *
   * `cells` is the ticked set of a single-cell container and is absent for every
   * other file — see {@link RunTarget.cells}. `label` is what the reader calls
   * the map (§16.10), which a plain Run names its results by.
   *
   * This and {@link context} answer for the starred map — or, asked about a
   * `task` that reads no map, for the session's own, whichever map is starred
   * (§18.1): a 1D task reads the session's tracks and is framed by its map.
   */
  source(task?: AnalysisTask): { uri: string; source: SourceSpec; cells?: readonly string[]; label?: string } | null
  context(task?: AnalysisTask): AnalysisContext | null
  framing(): AnalysisFraming | null
  block(): BlockInput | null
  /**
   * Where a synthetic lane becomes a row.
   *
   * `null` while the session has no annotation stores. Every file gets them, a
   * `.metacool` included (§8.5), so that is a session still building them: a
   * task can still produce a curve, a matrix or a table then, and a *profile*
   * has nowhere to be a lane. Said out loud in the drawer rather than silently
   * dropped; see {@link AnalysisWorkspace.adopt}.
   */
  store(): AnnotationStore | null
  /**
   * The map a result belongs to — the star (§18.2).
   *
   * A task reads one picture, and what it produces is a measurement *of that
   * picture*: an insulation track computed from the third replicate is a track
   * about the third replicate, and putting it on the lead would draw it beside a
   * map whose numbers it is not. Absent, or answering the lead, on a session
   * with no deck — which is every session until one is opened.
   */
  targetMap?(): MapId
  /**
   * Why no task that reads a map can run right now, or `null` — a deck where
   * the reader has left no map starred (§18.1). Such a task reads one file and
   * there is none named, so its row is greyed under this sentence and Run
   * refuses with it, rather than guessing a file on the reader's behalf. A task
   * that reads only the tracks (`readsMap`) names no file, and is let by.
   */
  blocked?(): string | null
  /**
   * Per-cell numbers a run measured, on their way to the Cells table (§3.8).
   *
   * The one result in the catalogue whose natural home is not the drawer. Every
   * other output is a figure or a lane; this one is a set of *columns about the
   * rows of a table the reader already sorts and ticks*, and the gesture it is
   * for — sort by a band, tick a run, sum them — is one this app has had since
   * `.scool` opened at all. So the numbers go there rather than growing a second
   * selection surface inside the drawer.
   *
   * Handed as the raw table so that this module stays free of UI types; the
   * shell turns it into columns.
   */
  cellMeasurements?(uri: string, table: TableOutput): void
  /**
   * The origins an *Origin and terminus* run placed, by sequence, in base
   * pairs — for the session to take into its declarations (§8.15), which is
   * what every task reading a chromosome's arms reads its origin from.
   */
  originsFound?(uri: string, origins: Readonly<Record<string, number>>): void

  /** Every map on screen, for a batch; see `AnalysisRunner.runAll`. */
  allTargets?(): readonly RunTarget[]
  /**
   * The same, once every map still opening has answered — what a batch runs on.
   *
   * See `Session`'s implementation for why the two are not one: the synchronous
   * answer leaves out a companion whose two tables have not been read, and a
   * batch that took it would run on fewer maps than its own button counted.
   */
  allTargetsReady?(): Promise<readonly RunTarget[]>
  /** How many maps a batch will end up covering, ready or not. */
  targetCount?(): number
  /** The worker a bin vector is registered with, so `sample` can answer for it. */
  annotations(): AnnotationClient | null
  /**
   * The assembly, for the two writers that lay a vector out over it — the
   * session's own for a `task` that reads no map, as {@link context} is.
   */
  contigs(task?: AnalysisTask): BedGraphContig[]
  /**
   * What the workspace this one replaces was holding, when it replaces one.
   *
   * Non-empty for exactly one case: the same file re-opened at another
   * resolution. See {@link AnalysisWorkspace.carry} for what is in it and
   * `Session.carry` for when it is filled.
   */
  carried?(): readonly CarriedResult[]
  /**
   * The group decisions for this file, where a surface is holding any.
   *
   * Only one thing here needs them: a task that emits a *set* of profiles can
   * say how the set reads (§18.11), and "these four overlay" is a fact about the
   * group rather than about any one of its lanes. Optional because a headless
   * caller has no picture at all, and `null` from a session whose annotations
   * are not built yet — either loses the suggestion and nothing else.
   */
  groups?(): GroupSettings | null
  /** A panel's availability changed, or a row needs repainting. */
  changed(): void
}

/** A finished profile, held for as long as an export could ask for it. */
export interface HeldProfile {
  output: ProfileOutput
  provenance: Provenance
  task: string
  /**
   * The bin grid these values are on — the assembly as it stood when the task
   * ran, not as it stands now.
   *
   * Carried with the numbers because it is the only thing that makes them
   * readable, and because the two can now come apart: a profile computed at 1 kb
   * that survives a switch to 5 kb is still a set of values on *1 kb bins*, and
   * re-registering it against the new file's grid would lay every value at five
   * times its true coordinate. A {@link BinVector} already carries its own
   * `binsize` and contig offsets precisely so that a vector and the map under it
   * need not be on the same grid; this is the field that keeps the right one.
   */
  grid: BinVectorContig[]
}

/** The same, for a called interval set. */
export interface HeldIntervals {
  output: IntervalsOutput
  provenance: Provenance
  task: string
}

/**
 * A computed row and the numbers behind it, on its way to the next workspace.
 *
 * The entry is the row *as the reader left it* — its colour, its name, its edge,
 * whether it was hidden — because carrying an analysis and then handing it back
 * with the defaults is a workspace that survived and a workspace that did not,
 * as far as anyone looking at the screen is concerned.
 */
export interface CarriedResult {
  entry: AnnotationEntry
  profile?: HeldProfile
  intervals?: HeldIntervals
}

export class AnalysisWorkspace {
  /** Goes in the Analysis column. */
  readonly panelEl: HTMLElement
  /** Goes in the shell's drawer slot. */
  readonly drawerEl: HTMLElement

  private readonly runner: AnalysisRunner
  private readonly panel: AnalysisPanelCard
  private readonly drawer: AnalysisDrawer
  private readonly profiles = new Map<string, HeldProfile>()
  /**
   * The interval outputs, for the same reason and with the same lifetime.
   *
   * The *coordinates* are on the entry — a `FeatureSet` is small enough to be a
   * payload — but the `TaskOutput` and its provenance are not, and both are what
   * a TSV export needs. Held here rather than duplicated into the store, exactly
   * as a profile's values are.
   */
  private readonly intervals = new Map<string, HeldIntervals>()
  private open: AnalysisTask | null = null
  /** What the loaded entries were last time a form was told about them. */
  private entries = ''
  private readonly unsubscribe: () => void

  constructor(private readonly host: AnalysisWorkspaceHost) {
    const runnerHost: RunnerHost = {
      context: (task) => this.host.context(task),
      source: (task) => this.host.source(task),
      block: () => this.host.block(),
      payload: (entryId) => this.host.store()?.byId(entryId)?.payload,
      // The reader's own name for the file, so an output that names an entry
      // names it the way they do rather than by the id the store minted.
      label: (entryId) => this.host.store()?.byId(entryId)?.label,
      vector: (entryId) => this.binVector(entryId),
      annotations: () => this.host.annotations(),
      contigLengths: (task) => {
        const out: Record<string, number> = {}
        for (const contig of this.host.contigs(task)) out[contig.name] = contig.length
        return out
      },
      // The star, so a plain Run files what it measured under the map it read
      // (§18.2) — and names it by that map rather than by the first one.
      ...(this.host.targetMap === undefined ? {} : { targetMap: () => this.host.targetMap?.() ?? LEAD_MAP }),
      allTargets: () => this.host.allTargets?.() ?? [],
      ...(this.host.allTargetsReady === undefined
        ? {}
        : { allTargetsReady: () => this.host.allTargetsReady?.() ?? Promise.resolve([]) }),
      ...(this.host.targetCount === undefined
        ? {}
        : { targetCount: () => this.host.targetCount?.() ?? 0 }),
      finished: (task, result, target) => this.adopt(task, result, target),
    }
    this.runner = new AnalysisRunner(runnerHost)

    this.panel = new AnalysisPanelCard({
      runner: this.runner,
      context: () => this.host.context(),
      blocked: () => this.host.blocked?.() ?? null,
      onOpen: (task) => this.show(task),
      active: () => this.open?.id ?? null,
    })
    this.panelEl = this.panel.el

    this.drawer = new AnalysisDrawer({
      runner: this.runner,
      context: (task) => this.host.context(task),
      blocked: () => this.host.blocked?.() ?? null,
      framing: () => this.host.framing(),
      onClose: () => this.show(null),
      // Read live rather than captured, because a session's store arrives with
      // the file and this workspace is built when the *view* mounts.
      //
      // **A store is not enough.** A *profile* is drawn from values that live
      // in the annotations worker ({@link register}), so a row in a store with
      // no worker beside it would be an empty lane under a sentence saying
      // where to find it. A metacool was that file — a store and a card for its
      // own metadata columns (§8.12), drawn from tables the main thread holds,
      // and no worker — until every file got one (§8.5). The question is
      // therefore whether a profile can be **drawn**, not whether a list exists
      // to put it in.
      hasLanes: () => this.laneable(),
      surfaces: (output) => {
        const store = this.host.store()
        if (store === null) return null
        for (const [id, held] of this.intervals) {
          if (held.output !== output) continue
          const entry = store.byId(id)
          if (entry !== undefined) {
            // Whether there is a map to put the set on, for the task that called it.
            const task = TASKS.find((candidate) => candidate.id === held.task)
            return calledSetFields(store, entry, { map: this.host.context(task)?.hasMap ?? true })
          }
        }
        return null
      },
      // The grid is passed rather than left to be looked up, because the two
      // callers of `writeProfile` do not agree about which one is right: the
      // drawer only ever holds what this workspace has just computed, so the
      // assembly under it now *is* the one those values are on — cut at the
      // output's own bin size ({@link gridFor}) — while a row on the card may
      // have been carried from another resolution and must be written over the
      // grid it was measured on.
      writeProfile: (output, provenance, format) =>
        this.writeProfile(output, provenance, format, this.gridFor(output.binsize)),
    })
    this.drawerEl = this.drawer.el

    // The rows themselves are the Tracks card's (§18.5): it lists what this
    // workspace adds to the store beside what the reader loaded, and asks here
    // for the two things only a computed row has — {@link exportEntry} and
    // {@link recompute}.
    const store = host.store()

    // The panel shows a running job's state whether or not the drawer is open
    // (§18.1), so both surfaces follow the runner rather than the drawer
    // following the panel.
    const stopRunner = this.runner.subscribe(() => {
      this.panel.refresh()
      this.drawer.refresh()
    })

    // …and the *store*, because a task's inputs are the loaded files and nothing
    // else told the form when one arrived. `SessionAnalysis.sync` runs after a
    // view mounts, and dropping a BEDPE mounts no view — so a reader who opened
    // the panel, dropped a loop table and pressed Run got "No loop set was
    // chosen" over a dropdown that had been empty since before the file existed.
    // Which reads as the task being broken rather than as the panel being stale.
    //
    // Guarded by a signature rather than refreshed on every change: the store
    // fires on each tick of a colour drag, and `setContext` refills every
    // control — including a column list that reads four hundred features to do
    // it. What a form cares about is which entries exist and what they are.
    //
    // …and the drawer's displays (§18.7), which a called set's own dropdown on
    // the Tracks card moves too: refilled when a set changes surface or look,
    // so the drawer never offers to move a set to where it already is.
    let displays = store === null ? '' : displaySignature(store)
    const stopStore =
      store === null
        ? () => {}
        : store.subscribe(() => {
            const shown = displaySignature(store)
            if (shown !== displays) {
              displays = shown
              this.drawer.fillSurfaces()
            }
            const now = entrySignature(store)
            if (now === this.entries) return
            this.entries = now
            this.refresh()
          })
    if (store !== null) this.entries = entrySignature(store)

    this.unsubscribe = () => {
      stopRunner()
      stopStore()
    }

    // Last, so that the rows land in a workspace that is already wired up: the
    // store subscription above is what repaints the card, and the signature it
    // guards on has just been taken.
    this.adoptCarried(host.carried?.() ?? [])
  }

  /**
   * Whether the Analysis column has anything to show.
   *
   * The same question the other three columns answer, and the same doctrine: a
   * task that means nothing on this file is absent rather than disabled (§8.5),
   * so a file that offers none has no column at all rather than an empty one.
   */
  get hasTasks(): boolean {
    const context = this.host.context()
    return context !== null && tasksFor(context).length > 0
  }

  /** Whether the drawer is up, so the shell knows to show the slot. */
  get isDrawerOpen(): boolean {
    return this.drawer.isOpen
  }

  /**
   * The task the drawer is open on, by id, or `null`.
   *
   * For the tutorial (§30), which asks the window questions rather than
   * listening for clicks: *is the drawer on Compartments* is the state its step
   * waits for, however the reader opened it.
   */
  get openTask(): string | null {
    return this.drawer.task?.id ?? null
  }

  /** Every finished run of a task on the starred map, newest first — the runner's own list. */
  runsOf(taskId: string): TaskResult[] {
    return this.runner.runsOf(taskId)
  }

  /** Whether a task is running or waiting to, as the panel's row shows it. */
  isRunning(taskId: string): boolean {
    const status = this.runner.stateOf(taskId).status
    return status === 'running' || status === 'queued'
  }

  /** Open the drawer on a task, or close it. */
  show(task: AnalysisTask | null): void {
    this.open = task
    this.drawer.show(task)
    this.panel.refresh()
    this.host.changed()
  }

  /** The context or the framing moved; repaint what depends on them. */
  refresh(): void {
    this.panel.refresh()
    this.drawer.refresh()
  }

  relayout(): void {
    this.drawer.relayout()
  }

  destroy(): void {
    this.unsubscribe()
    this.panel.destroy()
    this.drawer.destroy()
    this.runner.destroy()
    this.profiles.clear()
  }

  // -------------------------------------------------------------------------
  // A result becomes a lane
  // -------------------------------------------------------------------------

  /**
   * Take what a finished task produced.
   *
   * Two of the five output kinds leave the drawer. A curve, a matrix and a table
   * are *pictures of a computation* and live where they were asked for; a
   * **profile** is a track and a **set of intervals** is an overlay, and both of
   * those belong on the map (§18.5, §18.7). The drawer tells the reader as much
   * in so many words, so both have to actually arrive — a line saying "it is on
   * the Annotations panel" over a panel that has nothing new on it is worse than
   * no line at all.
   */
  private adopt(task: AnalysisTask, result: TaskResult, on: RunTarget): void {
    const map = on.map
    rememberParams(result.provenance.framing.uri, task.id, result.provenance.params)

    // **Before the early return below**, because this task produces neither a
    // profile nor an interval set: its output is a table, and its destination is
    // a table the shell owns rather than anything in this workspace.
    if (task.id === 'cellqc') {
      const measured = result.outputs.find(
        (output): output is TableOutput => output.kind === 'table' && output.id === 'cellqc',
      )
      if (measured !== undefined) {
        this.host.cellMeasurements?.(result.provenance.framing.uri, measured)
      }
    }

    // Also before it, for the same reason: the call is an ordinary table below,
    // and its origins are a declaration the session keeps as well.
    if (task.id === 'oriter') {
      const found = declaredOrigins(result.outputs)
      if (Object.keys(found).length > 0) {
        this.host.originsFound?.(result.provenance.framing.uri, found)
      }
    }

    const store = this.host.store()
    const profiles = result.outputs.filter(
      (output): output is ProfileOutput => output.kind === 'profile',
    )
    const intervals = result.outputs.filter(
      (output): output is IntervalsOutput => output.kind === 'intervals',
    )
    if (profiles.length === 0 && intervals.length === 0) return

    // **The two outputs need different things, so they are asked separately.**
    // A called interval set carries its own coordinates on the entry, so a
    // store is the whole of what it needs; a profile's values live in the
    // annotations worker, so it needs one of those as well ({@link laneable}).
    // A host with the first and not the second gets its boundaries as overlays
    // on the map and its profiles in the drawer that drew them. A metacool was
    // the file this split was written for (§8.12), and every file, a metacool
    // included, has both now (§8.5); the two are still two questions.
    if (store !== null && !this.laneable()) {
      for (const output of intervals) {
        this.adoptIntervals(task, result, output, store, on, null, false)
      }
      for (const output of profiles) {
        this.profiles.set(syntheticId(output.id), {
          output,
          provenance: result.provenance,
          task: task.id,
          grid: this.gridFor(output.binsize, task),
        })
      }
      this.drawer.refresh()
      this.host.changed()
      return
    }

    if (store === null) {
      // No store — a session whose annotations are not built yet, since every
      // file gets them, a metacool included (§8.5) — so there is no card for a
      // lane to be a row on and no overlay for called intervals. The
      // drawer draws the profile and carries its exports there (see
      // `AnalysisDrawer.block`) — which it can only do if the values are still
      // reachable when the button is pressed, so they are held exactly as they
      // are on a file that does have a card. Held under the ids the card would
      // have used, so a second run of the same task replaces its own numbers
      // rather than accumulating a copy per run.
      for (const output of intervals) {
        this.intervals.set(`analysis:${task.id}:${output.id}`, {
          output,
          provenance: result.provenance,
          task: task.id,
        })
      }
      for (const output of profiles) {
        this.profiles.set(syntheticId(output.id), {
          output,
          provenance: result.provenance,
          task: task.id,
          grid: this.gridFor(output.binsize, task),
        })
      }
      this.drawer.refresh()
      return
    }

    for (const output of profiles) {
      const source = {
        kind: 'computed' as const,
        name: output.label,
        task: task.id,
        recipe: {
          taskVersion: result.provenance.taskVersion,
          params: result.provenance.params,
          framing: result.provenance.framing,
        },
        framing: result.provenance.framing.label,
      }
      const entry = syntheticEntry(output, source, output.colour ?? store.nextColour(), on)
      // Before `begin`, which replaces the row: a run under an id already here
      // is new numbers for an old lane, and the caches have to be told.
      const previous = store.byId(entry.id)?.revision ?? 0
      // How the set reads, for a set that has an opinion (§18.11) — and only for
      // a group nobody has decided about, so a reader who stacked it and ran the
      // task again gets it back stacked.
      if (output.group !== undefined && output.groupMode !== undefined) {
        const groups = this.host.groups?.() ?? null
        const name = groupNameOn(output.group, on)
        if (groups !== null && !groups.knowsMode(name)) groups.setMode(name, output.groupMode)
      }
      // `begin` is the one door every row goes through, and it opens them
      // `loading`; the vector is already in hand, so this one is ready the
      // moment the worker has been told about it.
      store.begin({
        card: 'synthetic',
        kind: 'track',
        id: entry.id,
        label: entry.label,
        source,
        placement: entry.placement,
        style: entry.style,
      })
      this.placeOnTarget(store, entry.id, entry.placement, map)
      // The grid the task was run on, which for a 1D task is the session's own
      // map's whichever is starred — the runner cut its bins from the same list.
      const grid = this.gridFor(output.binsize, task)
      this.profiles.set(entry.id, {
        output,
        provenance: result.provenance,
        task: task.id,
        grid,
      })
      this.register(entry.id, output, grid)
      store.update(entry.id, {
        status: 'ready',
        ...(entry.fileExtent === undefined ? {} : { fileExtent: entry.fileExtent }),
        revision: previous + 1,
      })
    }

    // **After the profiles**, because a called set is placed under the profile
    // it was called from (§18.7), which has to be a row by then. With no row
    // named, each set goes under the run's last profile and the next under it,
    // so boundaries and the domains between them stack in the order the task
    // returned them.
    let under: string | null =
      profiles.length === 0 ? null : syntheticId(profiles[profiles.length - 1].id, map)
    for (const output of intervals) {
      const named = output.lane?.under
      const row = this.adoptIntervals(
        task,
        result,
        output,
        store,
        on,
        named === undefined ? under : 'output' in named ? syntheticId(named.output, map) : named.entry,
      )
      if (named === undefined && row !== null) under = row
    }
    if (intervals.length > 0) this.drawer.fillSurfaces()
    this.host.changed()
  }

  /**
   * A called interval set, as one ordinary row: a 1D track or an overlay.
   *
   * Boundaries from insulation, domains between them: a set of coordinates the
   * file did not come with, and the honest place for it is beside the BED
   * somebody would otherwise have exported and loaded back. So it goes through
   * the same `begin` → `ready` door a dropped file goes through, on the same
   * card, with the same colour, the same controls and — the point of the
   * exercise — the same **Save as BED** every other set of intervals has.
   *
   * There is no worker round trip, unlike a profile. A `FeatureSet` lives on the
   * main thread precisely so a pan redraws with no message (§8.4), and this one
   * is already here: the payload goes straight onto the entry.
   *
   * @param under The row it goes directly under in the list, where there is one.
   * @param lanes Whether this host draws lanes at all. One whose store has no
   *   annotation worker opens every set on the map, the surface it is sure of.
   * @returns The row's id, or `null` for a model, which is not a row of the
   *   Tracks card and has no slot there for the next set to go under.
   */
  private adoptIntervals(
    task: AnalysisTask,
    result: TaskResult,
    output: IntervalsOutput,
    store: AnnotationStore,
    on: RunTarget,
    under: string | null,
    lanes = true,
  ): string | null {
    const map = on.map
    const source: ComputedSource = {
      kind: 'computed',
      name: output.label,
      task: task.id,
      recipe: {
        taskVersion: result.provenance.taskVersion,
        params: result.provenance.params,
        framing: result.provenance.framing,
      },
      framing: result.provenance.framing.label,
    }
    // A reconstructed model (§25.6) is a `structure` row on the Structures
    // card — the cell draws it, the tasks that read a model read it, a bed3d
    // carries it away — and never an overlay: it is unplaced, as every
    // structure row is, and `placeOnTarget` below has nothing to place.
    const structure = output.entryKind === 'structure'
    // Scoped to the map, exactly as a profile's id is and for the same reason:
    // a batch over five maps called five sets of boundaries, and one id meant
    // each `begin` replaced the row before it while `placeOnTarget` moved the
    // single survivor onto the next panel and off the last. The lead keeps the
    // bare id it has always had, so a restored session still resolves.
    const base =
      map === LEAD_MAP
        ? `analysis:${task.id}:${output.id}`
        : `analysis:${map}:${task.id}:${output.id}`
    const label = map === LEAD_MAP ? output.label : `${output.label} · ${on.label}`
    const held = { output, provenance: result.provenance, task: task.id }

    // **Every other called set is one row, on one of two surfaces** (§18.7): a
    // 1D track of segments beside the map, or an overlay on the map it was
    // called from, as its display says (`analysis/surfaces.ts`). Running
    // insulation a second time with a wider window means the reader wants the
    // *new* boundaries, so the row lands on the id of its task and output and
    // replaces what was there, keeping where the reader put it; a panel that
    // grew a row per run is a panel nobody can read after four of them. A file
    // with no map — the 1D browser — has nothing to overlay, and the set is a
    // track there whatever the task would have opened it as.
    if (!structure) {
      const id = adoptCalledSet(store, {
        id: base,
        label,
        source,
        payload: output.payload,
        summary: countedAs(output),
        colour: store.byId(base)?.style.colour ?? store.nextColour(),
        map,
        display: !lanes
          ? 'overlay'
          : (output.display ?? (output.payload.kind === 'pairs' ? 'overlay' : 'lane')),
        look: output.look ?? 'corner',
        overlay: this.host.context(task)?.hasMap ?? true,
        under,
      })
      this.intervals.set(id, held)
      return id
    }

    // **A model accumulates.** Two models of one map, from two methods or two
    // exponents or the same settings twice, are the comparison the whole of
    // §25.3 is built for: `compare with`, `in the frame of`, turning them
    // together, a cell each. A second run that destroyed the first left a
    // reader with nothing to compare and no way back — the model is not stored
    // anywhere else, and *the same settings* is exactly the run somebody makes
    // to check a solver's seed. So a structure takes the first free id in the
    // series and keeps every model that has been made.
    const id = freshId(store, base)
    const run = id === base ? 1 : Number(id.slice(base.length + 1))
    const colour = store.nextColour()
    store.begin({
      card: 'structure',
      kind: 'structure',
      id,
      // Two models of one map under one name are two rows a reader cannot
      // tell apart in the picker, in `compare with`, or on the card.
      label: run > 1 ? `${label} (${run})` : label,
      source,
      placement: emptyPlacement(),
      style: defaultStyle('structure', colour),
    })
    store.update(id, {
      status: 'ready',
      payload: output.payload,
      summary: output.payload.kind === 'features' ? g3dSummary(output.payload.data) : countedAs(output),
    })
    this.intervals.set(id, held)
    return null
  }

  // -------------------------------------------------------------------------
  // Across a change of resolution
  // -------------------------------------------------------------------------

  /**
   * Everything computed, with the numbers behind it, for the workspace that
   * replaces this one.
   *
   * Switching the resolution of an `.mcool` re-opens the file: a new store keyed
   * on the new entry, a new annotations worker, a new workspace. Loaded tracks
   * already come through that intact — `Session.carry` hands the live rows over
   * — and a computed one is *more* worth carrying, not less: a bigWig can be
   * dropped again in a gesture, while a compartment eigenvector is four minutes
   * of arithmetic the tab is still holding the answer to.
   *
   * The numbers come across **unchanged and unrescaled**, which is the honest
   * thing and not a shortcut. A profile is a set of values on the bins it was
   * computed on; the row goes on saying so in its framing line, and
   * {@link HeldProfile.grid} is what keeps the vector readable against a map
   * that is now on a different grid. Re-binning it to the new resolution would
   * be inventing an insulation score at 5 kb that no window ever produced.
   *
   * Only ever consulted for the *same file* at another entry — see
   * `Session.carry`, and {@link AnnotationLoader.carry} for why a computed row is
   * emphatically not carried to a different one.
   */
  carry(): CarriedResult[] {
    const store = this.host.store()
    if (store === null) return []
    const out: CarriedResult[] = []
    for (const entry of store.entries) {
      if (entry.source.kind !== 'computed') continue
      const profile = this.profiles.get(entry.id)
      const intervals = this.intervals.get(entry.id)
      out.push({
        entry,
        ...(profile === undefined ? {} : { profile }),
        ...(intervals === undefined ? {} : { intervals }),
      })
    }
    return out
  }

  /**
   * Put them back, as the rows they were.
   *
   * The mirror of {@link adopt} rather than a second implementation of it: the
   * same `begin` → register → `ready` sequence, with the entry supplying what a
   * fresh result would have derived. A row whose numbers did *not* come across
   * — a detached one, restored from a reload and never recomputed — is replayed
   * with its own status, so the reader gets the Recompute button back rather
   * than an empty lane claiming to be ready.
   */
  /**
   * Put a freshly computed row on the map it was computed from.
   *
   * `begin` places every new track on the lead, which is what importing has
   * always meant and is right for a file the reader dropped. A *result* is not
   * an import: it is a measurement of one picture, and on a deck the picture is
   * whichever one the star is on. So the lane is moved the moment the row
   * exists — the same two calls a track dropped on a companion's edge makes
   * (`app/Session.ts`), and a no-op while the star is on the lead, which is
   * every session that has not opened a deck.
   */
  private placeOnTarget(
    store: AnnotationStore,
    id: string,
    placement: Placement,
    map: MapId,
  ): void {
    if (map === LEAD_MAP) return
    store.placeOn(id, map, placement)
    store.unplaceFrom(id, LEAD_MAP)
  }

  private adoptCarried(rows: readonly CarriedResult[]): void {
    const store = this.host.store()
    if (store === null || rows.length === 0) return
    for (const { entry, profile, intervals } of rows) {
      const source = entry.source
      if (source.kind !== 'computed') continue
      store.begin({
        card: entry.card,
        kind: entry.kind,
        id: entry.id,
        label: entry.label,
        source,
        placement: entry.placement,
        style: entry.style,
        visible: entry.visible,
        // A BAM's two rows cross together and stay linked (§8.13).
        ...(entry.partner === undefined ? {} : { partner: entry.partner }),
      })
      // Held here whether or not it can be a lane, because these values are
      // what the exports are written from — and registered only where there is
      // a worker to hold them ({@link laneable}).
      if (profile !== undefined) {
        this.profiles.set(entry.id, profile)
        this.register(entry.id, profile.output, profile.grid)
      }
      if (intervals !== undefined) this.intervals.set(entry.id, intervals)
      store.update(entry.id, {
        status: entry.status,
        ...(entry.summary === undefined ? {} : { summary: entry.summary }),
        ...(entry.payload === undefined ? {} : { payload: entry.payload }),
        ...(entry.fileExtent === undefined ? {} : { fileExtent: entry.fileExtent }),
      })
    }
    this.host.changed()
  }

  /** The assembly a vector computed *now* would be laid out over, for `task`. */
  private grid(task?: AnalysisTask): BinVectorContig[] {
    return this.host.contigs(task).map((contig) => ({
      name: contig.name,
      startBin: contig.startBin,
      bins: contig.bins,
      length: contig.length,
    }))
  }

  /**
   * The assembly a vector on bins of `binsize` is laid out over.
   *
   * The session's own ({@link grid}) at the session's resolution, which is where
   * every task but one puts its values. Base composition picks its bin size
   * (§18.8) — 10 kb in a 1D browser, any size beside a map — and its runner
   * lays the lanes out over the same sequences in the same order, each cut from
   * its first base into bins of that size ({@link gridAt}). Registered over the
   * session's grid instead, every sequence after the first would take its
   * values from the one before it.
   *
   * For the task that made the vector, since the session's grid is the
   * starred map's for a task that reads one and the session's own map's for a
   * task that reads none (`AnalysisWorkspaceHost.context`).
   */
  private gridFor(binsize: number, task?: AnalysisTask): BinVectorContig[] {
    return this.host.context(task)?.binsize === binsize
      ? this.grid(task)
      : gridAt(this.host.contigs(task), binsize)
  }

  /**
   * How many bins that grid has — the length of a vector laid out over it.
   *
   * **Not `context.nBins`, and the difference is the whole of a bug.** A matrix
   * bin count is what a *map* has, and `SessionAnalysis.context` reports zero
   * for a session that has none: a 1D browser session (§5.8) is given a real bin
   * grid — a browsing resolution and a `startBin` per sequence, so a per-bin
   * result computed from a track or a sequence is a lane there like anywhere
   * else — while `nBins` stays zero deliberately, because that is what keeps
   * `hasMap` false and the map tasks waiting.
   *
   * Reading the vector's length off `nBins` therefore made every whole-assembly
   * vector in a browser session **empty**, which is a file rather than an error:
   * a comparison of two bigWigs drew perfectly (the lane combines the operands'
   * own samples and never asks this) and then exported as a bigWig with a legal
   * header, no data blocks, and no complaint. The grid is the thing the writers
   * actually lay a vector out over, so the grid is what says how long the vector
   * is.
   *
   * The export that exposed it no longer comes through here — a comparison is
   * written at its operands' own resolution now ({@link exportDerived}), which
   * asks the worker for intervals rather than for a vector. What is left is the
   * *other* caller, the analysis runner's `vector` hook, where a task in the
   * analysis venue reads a loaded track or a sequence. That venue needs a map,
   * and a map's `nBins` is its grid's total by construction (§3.3) — so this is
   * the belt to that braces rather than the thing holding the trousers up. It
   * stays because the two numbers being equal is a property of one kind of
   * session and the grid is the right question in every kind.
   *
   * `startBin + bins` maxed over the list rather than read off the last entry,
   * so a caller handing the contigs in some other order still gets the total
   * rather than one contig's end.
   */
  private gridBins(): number {
    let total = 0
    for (const contig of this.host.contigs()) {
      total = Math.max(total, contig.startBin + contig.bins)
    }
    return total
  }

  /**
   * Any annotation entry, read onto this file's bin grid.
   *
   * The other direction from {@link register}, and the one that lets a task in
   * the analysis worker use an input the annotations worker holds — a bigWig it
   * ranks by, or a FASTA whose **GC content** decides the sign of a compartment
   * eigenvector (§18.6). Both go through `sample`, which is the point: GC is
   * answered by the same request a bigWig is, so this is one implementation and
   * not a special case for sequences.
   *
   * `basesPerPixel` is the bin size, so the worker picks the zoom level whose
   * windows are the file's bins and the reduction it already does per pixel is
   * the reduction wanted here. What comes back is intervals rather than bins, so
   * the mapping below is area-weighted for the reason `render/tracks.ts` gives:
   * taking whichever bin an interval starts in makes the answer jump as the
   * file's own window boundaries drift against the grid.
   *
   * One request for the whole assembly rather than one per contig. A metagenome
   * has four thousand of them and this is a single message either way.
   */
  private async binVector(entryId: string): Promise<Float32Array | undefined> {
    const client = this.host.annotations()
    const context = this.host.context()
    if (client === null || context === null) return undefined
    const contigs = this.host.contigs()
    if (contigs.length === 0) return undefined

    const binsize = context.binsize
    // The grid's own total, never `context.nBins` — see {@link gridBins}. Zero
    // means there is no grid to read onto at all, which is a bin size of zero
    // and nothing this can answer; `undefined` says so, and every caller already
    // handles a row it could not read.
    const nBins = this.gridBins()
    if (!(binsize > 0) || nBins === 0) return undefined
    const regions = contigs
      .filter((contig) => contig.length > 0)
      .map((contig) => ({ contig: contig.name, start: 0, end: contig.length }))
    let samples
    try {
      samples = await client.request<'sample'>({
        kind: 'sample',
        entry: entryId,
        regions,
        basesPerPixel: binsize,
      })
    } catch {
      // A row dropped between the form being filled in and Run being pressed.
      // The runner leaves the input out and the task names it, which is a better
      // answer than a vector of zeros nobody asked for.
      return undefined
    }

    const startOf = new Map(contigs.map((contig) => [contig.name, contig.startBin]))
    const out = new Float32Array(nBins).fill(Number.NaN)
    const weight = new Float64Array(nBins)
    const total = new Float64Array(nBins)
    for (const region of samples.regions) {
      const base = startOf.get(region.contig)
      if (base === undefined) continue
      for (let i = 0; i < region.values.length; i++) {
        const value = region.values[i]
        if (!Number.isFinite(value)) continue
        const from = region.starts[i]
        const to = region.ends[i]
        if (!(to > from)) continue
        const firstBin = Math.floor(from / binsize)
        const lastBin = Math.floor((to - 1) / binsize)
        for (let bin = firstBin; bin <= lastBin; bin++) {
          const absolute = base + bin
          if (absolute < 0 || absolute >= out.length) continue
          const overlap = Math.min(to, (bin + 1) * binsize) - Math.max(from, bin * binsize)
          if (!(overlap > 0)) continue
          total[absolute] += value * overlap
          weight[absolute] += overlap
        }
      }
    }
    for (let bin = 0; bin < out.length; bin++) {
      if (weight[bin] > 0) out[bin] = total[bin] / weight[bin]
    }
    return out
  }

  /**
   * Whether a per-bin result can be drawn as a lane on this file.
   *
   * Both halves are needed and they are different questions. The **store** is
   * where a row goes; the **annotations worker** is where its values go, and a
   * lane samples them from there like a bigWig's ({@link register}). A host
   * with the first and not the second can hold the row and cannot draw it,
   * which is the one outcome worse than not offering the row at all — and a
   * metacool was that file until every file got its worker (§8.5).
   */
  private laneable(): boolean {
    return this.host.store() !== null && this.host.annotations() !== null
  }

  /**
   * Tell the annotations worker about a vector, so `sample` can answer for it.
   *
   * This single call is what makes the lane a lane. Until it lands the row is on
   * the card and the renderer has nothing to draw; after it, nothing downstream
   * can tell the track from a bigWig (§18.5).
   */
  private register(entryId: string, output: ProfileOutput, grid: BinVectorContig[]): void {
    const client = this.host.annotations()
    if (client === null) return
    const vector: BinVector = {
      binsize: output.binsize,
      firstBin: output.extent[0],
      // A copy, because the worker takes ownership of what it is sent and this
      // module still needs the numbers for an export — and because a carried
      // vector is registered a second time, with a second worker, from the same
      // array.
      values: output.values.slice(),
      contigs: grid,
    }
    void client.request<'register'>({ kind: 'register', entry: entryId, vector }).catch(() => {
      // A registration that fails leaves a row with no values, which the lane
      // already draws as an empty track. Not worth an error card: the numbers
      // are still exportable from this module, which is what they are for.
    })
  }

  /**
   * Re-run the recipe behind a detached row.
   *
   * It opens the drawer on the task rather than running it silently, and that is
   * the point: the row came back `detached` because the *values* did not survive
   * the reload, and the framing it was computed over may no longer be the one on
   * screen. Putting the recipe in front of the reader with a Run button is the
   * honest version of "recompute"; doing it behind their back would produce a
   * lane whose provenance line describes a picture they are not looking at.
   */
  recompute(entry: AnnotationEntry): void {
    const source = entry.source
    if (source.kind !== 'computed') return
    const task = TASKS.find((candidate) => candidate.id === source.task)
    if (task === undefined) return
    this.show(task)
  }

  /**
   * When the run behind a computed row was made, or `undefined` for a row this
   * workspace holds no run for — every loaded one, and a computed one restored
   * from a reload, whose numbers did not come back either.
   *
   * For the Structures card, which writes a model's bed3d itself and whose `#`
   * line said what the model was and what it was made from but not when (§25.7)
   * — where the drawer's button and `chromosomix` both say all three. The
   * date is the run's provenance, which lives here beside the numbers and never
   * on the store (§18.5), so the card asks.
   */
  createdAt(id: string): string | undefined {
    return this.intervals.get(id)?.provenance.createdAt
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  /**
   * Write one computed row out, as its row on the Tracks card asks (§18.7).
   *
   * Here and not on the card, because the values are here: a profile's vector
   * and a called set's provenance are held by this workspace for as long as the
   * tab is open, and never by the store (§18.5).
   */
  async exportEntry(entry: AnnotationEntry, format: SyntheticFormat): Promise<void> {
    const stamp = fileStamp(new Date())
    const base = exportBaseName(entry.label)

    // A called interval set has no bin vector behind it — its numbers *are* its
    // coordinates, and they are on the entry. Written through the same
    // `annotations/export.ts` the hand-drawn marks use, so there is one opinion
    // in this repository about where a half-open interval ends.
    if (format === 'bed') {
      // The set as it was called, whichever surface it is on: a loop set shown
      // as its anchors still leaves as its loops (§18.7).
      const payload = calledPayloadOf(entry)
      if (payload === undefined) return
      const held = this.intervals.get(entry.id)
      const context = {
        label: entry.label,
        ...(held === undefined
          ? {}
          : { file: held.provenance.framing.label, created: held.provenance.createdAt }),
      }
      // A structure row leaves as the bed3d it would have been loaded from
      // (§25.7), through the same writer the Structures card's button uses.
      const structure = entry.kind === 'structure' && payload.kind === 'features'
      const text = structure ? writeBed3d(payload.data, context) : formatIntervals(payload, context)
      const suffix = structure ? 'bed3d' : payload.kind === 'pairs' ? 'bedpe' : 'bed'
      void downloadBlob(new Blob([text], { type: 'text/plain' }), `${base}-${stamp}.${suffix}`)
      return
    }

    const intervalHeld = this.intervals.get(entry.id)
    if (intervalHeld !== undefined && format === 'tsv') {
      void downloadBlob(
        new Blob([outputToTsv(intervalHeld.output, intervalHeld.provenance)], {
          type: 'text/tab-separated-values',
        }),
        tsvName(base, intervalHeld.output, stamp),
      )
      return
    }

    // A comparison of two loaded tracks holds no numbers of its own: it is
    // recomputed from its operands every time it is drawn, which is what keeps
    // it exact at every zoom. A *file* has to be on some grid, so this is where
    // the grid is chosen — and it is the map's own, the same one every other
    // synthetic track is written on.
    if (entry.source.kind === 'derived') {
      await this.exportDerived(entry, format, base, stamp)
      return
    }

    const held = this.profiles.get(entry.id)
    if (held === undefined) return

    if (format === 'tsv') {
      void downloadBlob(
        new Blob([outputToTsv(held.output, held.provenance)], { type: 'text/tab-separated-values' }),
        tsvName(base, held.output, stamp),
      )
      return
    }

    // `held.grid`, emphatically not `host.contigs()`: after a change of
    // resolution the two are different assemblies and only the held one belongs
    // to these numbers ({@link HeldProfile.grid}).
    await this.writeProfile(held.output, held.provenance, format, held.grid, base)
  }

  /**
   * A per-bin vector as one of the two files a genome browser opens.
   *
   * Public to the drawer as well as to the card, because where there is no lane
   * ({@link laneable}) the drawer is the only surface a profile has: no row, so
   * no row's export row, and §18.7's *bigWig for a signal, bedGraph, BED, TSV,
   * PNG and vector PDF* would be a claim this app did not keep there. A
   * `.metacool` was that file until every file got its annotations worker
   * (§8.5). One implementation for both, rather than the drawer growing a
   * second copy of the writers and a second opinion about where a bin ends.
   *
   * **`grid` is the assembly these values were computed over, and the caller
   * supplies it because this method cannot know it.** It used to read
   * `host.contigs()` — the grid the session is on *now* — which is the same list
   * right up until a profile is carried across a change of resolution
   * ({@link carry}), and wrong from then on. A 1 kb vector exported after a
   * switch to 5 kb was laid out over the 5 kb contig offsets: every contig after
   * the first took its rows from the previous contig's values, and each stopped
   * after its 5 kb bin count, so about four fifths of the vector was never
   * written at all. The bigWig came out right anyway — `writeBigWig` rebuilds
   * the offsets from each contig's `length` and the profile's own `binsize`,
   * both of which are invariant under the switch — which made it worse rather
   * than better: the two files offered for one row disagreed, and agreeing cell
   * for cell is the first thing `write/bedgraph.ts` claims. Both writers are
   * given the same list here so there is one answer about which assembly a file
   * is laid out over, and so a contig set that genuinely changed would take the
   * bigWig with it instead of being silently absorbed.
   */
  /**
   * A derived lane as a file: **what the lane draws, at the resolution it draws
   * it**, and no grid imposed on the way out.
   *
   * This used to read both operands onto the contact map's bins and write the
   * result as a bin vector, on the argument that a bigWig is values on a grid so
   * a file has to pick one. The premise was simply false — a bedGraph section
   * holds arbitrary intervals, which is decision 1 of `write/bigwig.ts` and has
   * been since it was written — and the consequence was that a ratio of two
   * 10 bp tracks looked at on a 20 kb map came out as a 20 kb file. Every
   * boundary in the data was gone, the numbers were means of means, and nothing
   * in the file or on the row said so: the lane on screen was exact and the
   * download was not, which is the worst version of this failure because the
   * picture the reader is checking against agrees with them.
   *
   * So the operands are sampled `exact`ly — the bigWig's own intervals, the
   * whole of a computed vector's bins — and combined by the **same
   * `combineSamples` the lane draws with**, over the common refinement of both.
   * The file is then that step function, written interval for interval. A ratio
   * of two 10 bp tracks is a 10 bp file; a ratio of two 20 kb tracks is a 20 kb
   * file; and neither is a decision this method makes, which is the point.
   *
   * `'drop'` rather than the lane's clamping, for the reason `combineVectors`
   * gave when it was the only road to a file: a pixel has to go somewhere and an
   * interval does not, so `x / 0` is written as no reading at all.
   *
   * Nothing is cached. An export is a gesture, not a state, and holding a
   * genome's worth of two sampled tracks against the chance of a second one is
   * megabytes kept for a button nobody may press again.
   */
  private async exportDerived(
    entry: AnnotationEntry,
    format: SyntheticFormat,
    base: string,
    stamp: string,
  ): Promise<void> {
    const recipe = entry.derivedFrom
    const context = this.host.context()
    if (recipe === undefined || context === null || format === 'bed') return
    // Where it goes first, while the press is still the reader's: sampling two
    // tracks over a genome can outlast the moment a browser will still open a
    // save dialog for (`ui/export.ts`).
    const target = await chooseSaveTarget(
      `${base}-${stamp}.${format === 'tsv' ? 'tsv' : format === 'bedgraph' ? 'bedGraph' : 'bw'}`,
      format === 'tsv' ? 'text/tab-separated-values' : format === 'bedgraph' ? 'text/plain' : 'application/octet-stream',
    )
    if (target === null) return
    const [a, b] = await Promise.all([
      this.exactSamples(recipe.a),
      this.exactSamples(recipe.b),
    ])
    // An operand that has been dropped, or a row that never loaded. Silent
    // rather than a dialog: the row itself goes when its operand does
    // (`annotations/store.ts`), so this is the moment between the two.
    const combined = combineSamples(a, b, recipe.op, 'drop')
    if (combined === null) return

    const spans = combined.regions.map((region) => ({
      contig: region.contig,
      starts: region.starts,
      ends: region.ends,
      values: region.values,
    }))
    const provenance = derivedProvenance(entry, recipe.op, context)
    const grid = this.host.contigs()

    if (format === 'tsv') {
      await target.write(
        new Blob([spansToTsv(entry.label, TRACK_OP_LABELS[recipe.op], spans, grid, provenance)], {
          type: 'text/tab-separated-values',
        }),
      )
      return
    }
    if (format === 'bedgraph') {
      await target.write(new Blob([spansToBedGraph(spans, grid, provenance)], { type: 'text/plain' }))
      return
    }
    const blob = await writeBigWig({
      contigs: grid.map((contig) => ({ name: contig.name, length: contig.length })),
      spans,
    })
    await target.write(blob)
  }

  /**
   * One operand, at its own resolution, over the whole assembly.
   *
   * The difference from {@link binVector} is the whole of this change and it is
   * two arguments: `basesPerPixel: 1` asks a bigWig for its own intervals rather
   * than for whichever zoom level suits a span, and `exact` tells a computed
   * vector to answer bin for bin rather than folding into the few thousand
   * buckets a frame can draw. Neither is a resolution *chosen* here — both say
   * "whatever the data is", which is what an export wants and what a frame never
   * does.
   *
   * Sized by the operands rather than by the genome, which is why one request
   * for the whole assembly is still the right shape: a bigWig holds intervals
   * and not bases, so what comes back is about what the file itself holds — the
   * same order of magnitude as the file the reader already has on disk.
   */
  private async exactSamples(entryId: string): Promise<TrackSampleSet | null> {
    const client = this.host.annotations()
    if (client === null) return null
    const contigs = this.host.contigs().filter((contig) => contig.length > 0)
    if (contigs.length === 0) return null
    try {
      return await client.request<'sample'>({
        kind: 'sample',
        entry: entryId,
        regions: contigs.map((contig) => ({ contig: contig.name, start: 0, end: contig.length })),
        basesPerPixel: 1,
        exact: true,
      })
    } catch {
      // A row dropped between the button being pressed and the worker answering.
      return null
    }
  }

  private async writeProfile(
    output: ProfileOutput,
    provenance: Provenance,
    format: 'bigwig' | 'bedgraph',
    grid: readonly BedGraphContig[],
    name = exportBaseName(output.label),
  ): Promise<void> {
    const stamp = fileStamp(new Date())
    // Where it goes first, while the press is still the reader's (`ui/export.ts`).
    const target = await chooseSaveTarget(
      `${name}-${stamp}.${format === 'bedgraph' ? 'bedGraph' : 'bw'}`,
      format === 'bedgraph' ? 'text/plain' : 'application/octet-stream',
    )
    if (target === null) return
    if (format === 'bedgraph') {
      await target.write(new Blob([profileToBedGraph(output, grid, provenance)], { type: 'text/plain' }))
      return
    }

    // The one export that can genuinely fail — a browser with no
    // `CompressionStream` still produces a legal file, but a vector that does
    // not line up with the assembly is a caller bug and throws.
    const blob = await writeBigWig({
      contigs: grid.map((contig) => ({ name: contig.name, length: contig.length })),
      values: output.values,
      firstBin: output.extent[0],
      binsize: output.binsize,
    })
    await target.write(blob)
  }

}

/**
 * `1,204 pairs` — how many things a task called.
 *
 * The first thing a reader wants from a called set and the last thing the row
 * used to say. A dropped BEDPE has carried its count under its name since there
 * were rows at all (`annotations/worker`), and a *computed* set carried nothing:
 * so a run that found three loops and a run that found three thousand were the
 * same row, and the only way to tell them apart was to export the file and count
 * it. Written here, on the same `summary` field the loaded rows use and read by
 * the same line of the same card, so the two kinds of row say the number the
 * same way rather than in two places that can drift.
 *
 * The task's own noun where it gave one ({@link IntervalsOutput.noun}) and the
 * payload's shape where it did not — the fallback is what a reader would say
 * about a set nobody has named, and it is never wrong, only general.
 */
/**
 * The first id in `base`, `base#2`, `base#3`… that no row holds.
 *
 * A series rather than a stamp or a counter on this object: an id has to be
 * the same after a reload, and it has to be readable in a link and in the
 * store's own listing. Numbering from what is *there* also means a reader who
 * closes the second of three models gets `#2` back on their next run, which is
 * the answer somebody counting rows on the card would give.
 */
export function freshId(store: AnnotationStore, base: string): string {
  if (store.byId(base) === undefined) return base
  for (let run = 2; run < 1000; run++) {
    const id = `${base}#${run}`
    if (store.byId(id) === undefined) return id
  }
  return `${base}#${Date.now()}`
}

function countedAs(output: IntervalsOutput): string {
  const payload = output.payload
  const total = payload.data.length
  const noun =
    output.noun ??
    (payload.kind === 'pairs'
      ? { one: 'pair', many: 'pairs' }
      : { one: 'interval', many: 'intervals' })
  return `${fmt.int(total)} ${total === 1 ? noun.one : noun.many}`
}

/**
 * The header a derived export carries.
 *
 * There is no task behind it, and inventing one would be worse than saying so:
 * what made these numbers is two rows the reader picked and an operation they
 * chose, which is exactly what goes in `task` and `params`. The framing line is
 * the one that earns its place — it names the grid the file is on, which is the
 * single way this file differs from the lane it came from.
 *
 * Which grid that is depends on whether there is a map. With one it is the open
 * file's own bins, and saying so is the point. Without one — a 1D browser
 * session, where comparing two bigWigs is the likeliest reason to be here at all
 * — there is no file whose bins these are: the grid is the browsing resolution
 * the assembly was given, and calling it “this file’s” would name a resolution
 * nothing was measured at.
 */
function derivedProvenance(
  entry: AnnotationEntry,
  op: TrackOp,
  context: AnalysisContext,
): Provenance {
  const bins = `${context.binsize.toLocaleString()} bp bins`
  return {
    task: `track ${TRACK_OP_LABELS[op]}`,
    taskVersion: 1,
    params: { operation: op, of: entry.label },
    framing: {
      uri: context.uri,
      label: context.hasMap
        ? `two loaded tracks, read onto this file’s ${bins}`
        : `two loaded tracks, read onto the assembly’s ${bins}`,
      binsize: context.binsize,
      binsPerCell: 1,
      rows: [0, context.nBins],
      cols: [0, context.nBins],
      balance: false,
      value: '',
      normalise: null,
      level: 'bin',
    },
    app: VERSION,
    createdAt: new Date().toISOString(),
  }
}

/**
 * What a form needs to know about the loaded files, as one string.
 *
 * Id, kind and status, in order — the three things `candidatesFor` filters on to
 * decide what a task may be run against — and the **name**, which is what the
 * form lists each of them by. A colour, a height and an edge are absent on
 * purpose: none of them changes what the form says, and a colour fires the
 * store on every tick of its drag.
 *
 * The name was left out too, on the grounds that a rename fired on every
 * keystroke and refilling every control per keystroke was dear. No rename does:
 * each box commits on Enter or on leaving it. So it is in, and a form open
 * while a track or a model is renamed lists it under the name the run will
 * write — the outputs always took the new name, and a dropdown still offering
 * the old one read as the run ignoring it.
 */
export function entrySignature(store: AnnotationStore): string {
  return store.entries
    .map((entry) => `${entry.id}:${entry.kind}:${entry.status}:${entry.label}`)
    .join('|')
}

/**
 * Where each called set is drawn and how it looks (§18.7): what the drawer's
 * display dropdowns show, and so what refills them when a row's own changes.
 * A colour dragged or a lane resized leaves it alone.
 */
function displaySignature(store: AnnotationStore): string {
  return store.entries
    .filter(isCalledSet)
    .map((entry) => `${entry.id}:${entry.card}:${entry.style.shape}`)
    .join('|')
}
