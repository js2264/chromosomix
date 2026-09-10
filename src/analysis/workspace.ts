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
 * the annotations worker so `sample` can answer for it, and a row on the
 * synthetic card with somewhere for its exports to go — and this is the only
 * place that knows all three exist.
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
 * same region at 5 kb found the Synthetic tracks card empty, having lost numbers
 * the tab was still holding for no reason other than which object held them.
 */

import type { AnnotationClient } from '../annotations/worker/client'
import type { BinVector, BinVectorContig } from '../annotations/worker/binVector'
import { LEAD_MAP, type MapId } from '../annotations/placement'
import { defaultStyle, emptyPlacement } from '../annotations/types'
import type { Placement } from '../annotations/types'
import type { AnnotationEntry, ComputedSource } from '../annotations/types'
import type { AnnotationStore } from '../annotations/store'
import { el } from '../ui/dom'
import { downloadBlob, exportBaseName, fileStamp } from '../ui/export'
import { AnalysisDrawer } from '../ui/AnalysisDrawer'
import { AnalysisPanelCard } from '../ui/AnalysisPanelCard'
import {
  SyntheticCard,
  syntheticEntry,
  syntheticId,
  type SyntheticFormat,
} from '../ui/SyntheticCard'
import type { SourceSpec } from '../worker/protocol'
import { TASKS, tasksFor } from './registry'
import { AnalysisRunner, type RunnerHost, type RunTarget } from './runner'
import { rememberParams } from './memory'
import type {
  AnalysisContext,
  AnalysisFraming,
  AnalysisTask,
  IntervalsOutput,
  ProfileOutput,
  Provenance,
  TaskResult,
} from './types'
import type { BlockInput } from './worker/protocol'
import { profileToBedGraph, type BedGraphContig } from './write/bedgraph'
import { writeBigWig } from './write/bigwig'
import { outputToTsv, tsvName } from './write/tsv'
import { formatIntervals } from '../annotations/export'

/** What the workspace needs from the session around it. */
export interface AnalysisWorkspaceHost {
  /**
   * How the analysis worker should mount the file; `null` before anything is open.
   *
   * `cells` is the ticked set of a single-cell container and is absent for every
   * other file — see {@link RunTarget.cells}.
   */
  source(): { uri: string; source: SourceSpec; cells?: readonly string[] } | null
  context(): AnalysisContext | null
  framing(): AnalysisFraming | null
  block(): BlockInput | null
  /**
   * Where a synthetic lane becomes a row.
   *
   * `null` on a `.metacool`, which carries no annotations at all (§8.5) — so a
   * task there can still produce a curve, a matrix or a table, and a *profile*
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
  /**
   * Every map a lane may be drawn on, named — what the Tracks card is given.
   *
   * Not {@link allTargets}, which lists the maps an analysis can *run against*
   * and therefore leaves out a companion whose two tables have not been read
   * yet. Where a track may be **drawn** is a question about the grid, and a
   * panel that is still opening its file is very much a cell of it.
   */
  maps?(): Array<{ id: string; label: string }>
  /** The worker a bin vector is registered with, so `sample` can answer for it. */
  annotations(): AnnotationClient | null
  /** The assembly, for the two writers that lay a vector out over it. */
  contigs(): BedGraphContig[]
  /**
   * What the workspace this one replaces was holding, when it replaces one.
   *
   * Non-empty for exactly one case: the same file re-opened at another
   * resolution. See {@link AnalysisWorkspace.carry} for what is in it and
   * `Session.carry` for when it is filled.
   */
  carried?(): readonly CarriedResult[]
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
  /** Goes in the Annotations column, under the Tracks card. */
  readonly syntheticEl: HTMLElement

  private readonly runner: AnalysisRunner
  private readonly panel: AnalysisPanelCard
  private readonly drawer: AnalysisDrawer
  /**
   * `null` on a file that carries no annotations at all (§8.5).
   *
   * A metacool has no Tracks card, so it has no card for a synthetic lane to be
   * a row on either — and a card built against a store that does not exist would
   * be a permanently empty box in a crowded column. A task there still produces
   * its curves, its matrices and its tables; only the *profile* has nowhere to
   * go, and {@link adopt} says so rather than dropping it.
   */
  private readonly synthetic: SyntheticCard | null
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
      context: () => this.host.context(),
      source: () => this.host.source(),
      block: () => this.host.block(),
      payload: (entryId) => this.host.store()?.byId(entryId)?.payload,
      // The reader's own name for the file, so an output that names an entry
      // names it the way they do rather than by the id the store minted.
      label: (entryId) => this.host.store()?.byId(entryId)?.label,
      vector: (entryId) => this.binVector(entryId),
      annotations: () => this.host.annotations(),
      contigLengths: () => {
        const out: Record<string, number> = {}
        for (const contig of this.host.contigs()) out[contig.name] = contig.length
        return out
      },
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
      onOpen: (task) => this.show(task),
      active: () => this.open?.id ?? null,
    })
    this.panelEl = this.panel.el

    this.drawer = new AnalysisDrawer({
      runner: this.runner,
      context: () => this.host.context(),
      framing: () => this.host.framing(),
      onClose: () => this.show(null),
      // Read live rather than captured, because a session's store arrives with
      // the file and this workspace is built when the *view* mounts.
      //
      // **A store is not enough**, and the file that proves it is a metacool.
      // Since §8.12 one has a store, a placement model and a card — for its own
      // metadata columns, which are drawn from tables the main thread holds. A
      // *profile* is drawn from values that live in the annotations worker
      // ({@link register}), and a metacool has no such worker (§8.5), so a row
      // there would be an empty lane under a sentence saying where to find it.
      // The question is therefore whether a profile can be **drawn**, not
      // whether a list exists to put it in.
      hasLanes: () => this.laneable(),
      // The grid is passed rather than left to be looked up, because the two
      // callers of `writeProfile` do not agree about which one is right: the
      // drawer only ever holds what this workspace has just computed, so the
      // assembly under it now *is* the grid those values are on, while a row on
      // the card may have been carried from another resolution and must be
      // written over the grid it was measured on.
      writeProfile: (output, provenance, format) =>
        this.writeProfile(output, provenance, format, this.grid()),
    })
    this.drawerEl = this.drawer.el

    const store = host.store()
    this.synthetic =
      store === null
        ? null
        : new SyntheticCard({
            store,
            // The same list the Tracks card is given, so §18.5's claim that a
            // computed track is a track like any other holds for the one
            // control it was still missing: which map, and which edge of it.
            ...(host.maps === undefined ? {} : { maps: () => host.maps?.() ?? [] }),
            onExport: (entry, format) => void this.export(entry, format),
            onRecompute: (entry) => this.recompute(entry),
          })
    this.syntheticEl = this.synthetic?.el ?? el('div', { class: 'synthetic-absent' })

    // The panel shows a running job's state whether or not the drawer is open
    // (§18.1), so both surfaces follow the runner rather than the drawer
    // following the panel.
    const stopRunner = this.runner.subscribe(() => {
      this.panel.refresh()
      this.drawer.refresh()
    })

    // …and the *store*, because a task's inputs are the loaded files and nothing
    // else told the form when one arrived. `syncAnalysis` runs after a view
    // mounts, and dropping a BEDPE mounts no view — so a reader who opened the
    // panel, dropped a loop table and pressed Run got "No loop set was chosen"
    // over a dropdown that had been empty since before the file existed. Which
    // reads as the task being broken rather than as the panel being stale.
    //
    // Guarded by a signature rather than refreshed on every change: the store
    // fires on each tick of a colour drag, and `setContext` refills every
    // control — including a column list that reads four hundred features to do
    // it. What a form cares about is which entries exist and what they are.
    const stopStore =
      store === null
        ? () => {}
        : store.subscribe(() => {
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
    this.synthetic?.refresh()
  }

  relayout(): void {
    this.drawer.relayout()
  }

  destroy(): void {
    this.unsubscribe()
    this.panel.destroy()
    this.drawer.destroy()
    this.synthetic?.destroy()
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
    // A metacool has the first and not the second (§8.5, §8.12), which is
    // exactly the file this split exists for: its boundaries become overlays on
    // the map, and its profiles stay in the drawer that drew them.
    if (store !== null && !this.laneable()) {
      for (const output of intervals) this.adoptIntervals(task, result, output, store, on)
      for (const output of profiles) {
        this.profiles.set(syntheticId(output.id), {
          output,
          provenance: result.provenance,
          task: task.id,
          grid: this.grid(),
        })
      }
      this.synthetic?.refresh()
      this.drawer.refresh()
      this.host.changed()
      return
    }

    if (store === null) {
      // §8.5: a file with a genome layer carries no annotations, so there is no
      // card for a lane to be a row on and no overlay for called intervals. The
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
          grid: this.grid(),
        })
      }
      this.drawer.refresh()
      return
    }

    for (const output of intervals) this.adoptIntervals(task, result, output, store, on)

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
      const grid = this.grid()
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
      })
    }
    this.synthetic?.refresh()
    this.host.changed()
  }

  /**
   * A called interval set, as an ordinary overlay row.
   *
   * Boundaries from insulation, domains from CID: a set of coordinates the file
   * did not come with, and the honest place for it is beside the BED somebody
   * would otherwise have exported and loaded back. So it goes through the same
   * `begin` → `ready` door a dropped file goes through, on the same card, with
   * the same colour, the same shape controls and — the point of the exercise —
   * the same **Save as BED** that every other overlay has.
   *
   * There is no worker round trip, unlike a profile. A `FeatureSet` lives on the
   * main thread precisely so a pan redraws with no message (§8.4), and this one
   * is already here: the payload goes straight onto the entry.
   */
  private adoptIntervals(
    task: AnalysisTask,
    result: TaskResult,
    output: IntervalsOutput,
    store: AnnotationStore,
    on: RunTarget,
  ): void {
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
    const kind = output.payload.kind === 'pairs' ? 'pairs' : 'segments'
    // Scoped to the map, exactly as a profile's id is and for the same reason:
    // a batch over five maps called five sets of boundaries, and one id meant
    // each `begin` replaced the row before it while `placeOnTarget` moved the
    // single survivor onto the next panel and off the last. The lead keeps the
    // bare id it has always had, so a restored session still resolves.
    const id =
      map === LEAD_MAP
        ? `analysis:${task.id}:${output.id}`
        : `analysis:${map}:${task.id}:${output.id}`
    const colour = store.nextColour()
    // Replacing rather than accumulating: running insulation a second time with
    // a wider window means the reader wants the *new* boundaries, and a panel
    // that grows a row per run is a panel nobody can read after four of them.
    // The id is the task and the output, so a second run of the same task lands
    // on the same row and a different task never does.
    if (store.byId(id) !== undefined) store.remove(id)
    store.begin({
      card: 'overlay',
      kind,
      id,
      label: map === LEAD_MAP ? output.label : `${output.label} · ${on.label}`,
      source,
      placement: emptyPlacement(),
      style: defaultStyle(kind, colour),
    })
    this.placeOnTarget(store, id, emptyPlacement(), map)
    store.update(id, { status: 'ready', payload: output.payload })
    this.intervals.set(id, { output, provenance: result.provenance, task: task.id })
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
    this.synthetic?.refresh()
    this.host.changed()
  }

  /** The assembly a vector computed *now* would be laid out over. */
  private grid(): BinVectorContig[] {
    return this.host.contigs().map((contig) => ({
      name: contig.name,
      startBin: contig.startBin,
      bins: contig.bins,
      length: contig.length,
    }))
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
    const out = new Float32Array(context.nBins).fill(Number.NaN)
    const weight = new Float64Array(context.nBins)
    const total = new Float64Array(context.nBins)
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
   * Tell the annotations worker about a vector, so `sample` can answer for it.
   *
   * This single call is what makes the lane a lane. Until it lands the row is on
   * the card and the renderer has nothing to draw; after it, nothing downstream
   * can tell the track from a bigWig (§18.5).
   */
  /**
   * Whether a per-bin result can be drawn as a lane on this file.
   *
   * Both halves are needed and they are different questions. The **store** is
   * where a row goes; the **annotations worker** is where its values go, and a
   * lane samples them from there like a bigWig's ({@link register}). A file
   * with the first and not the second — a metacool since §8.12 — can hold the
   * row and cannot draw it, which is the one outcome worse than not offering
   * the row at all.
   */
  private laneable(): boolean {
    return this.host.store() !== null && this.host.annotations() !== null
  }

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
  private recompute(entry: AnnotationEntry): void {
    const source = entry.source
    if (source.kind !== 'computed') return
    const task = TASKS.find((candidate) => candidate.id === source.task)
    if (task === undefined) return
    this.show(task)
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  private async export(entry: AnnotationEntry, format: SyntheticFormat): Promise<void> {
    const stamp = fileStamp(new Date())
    const base = exportBaseName(entry.label)

    // A called interval set has no bin vector behind it — its numbers *are* its
    // coordinates, and they are on the entry. Written through the same
    // `annotations/export.ts` the hand-drawn marks use, so there is one opinion
    // in this repository about where a half-open interval ends.
    if (format === 'bed') {
      const payload = entry.payload
      if (payload === undefined) return
      const held = this.intervals.get(entry.id)
      downloadBlob(
        new Blob(
          [
            formatIntervals(payload, {
              label: entry.label,
              ...(held === undefined
                ? {}
                : { file: held.provenance.framing.label, created: held.provenance.createdAt }),
            }),
          ],
          { type: 'text/plain' },
        ),
        `${base}-${stamp}.${payload.kind === 'pairs' ? 'bedpe' : 'bed'}`,
      )
      return
    }

    const intervalHeld = this.intervals.get(entry.id)
    if (intervalHeld !== undefined && format === 'tsv') {
      downloadBlob(
        new Blob([outputToTsv(intervalHeld.output, intervalHeld.provenance)], {
          type: 'text/tab-separated-values',
        }),
        tsvName(base, intervalHeld.output, stamp),
      )
      return
    }

    const held = this.profiles.get(entry.id)
    if (held === undefined) return

    if (format === 'tsv') {
      downloadBlob(
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
   * Public to the drawer as well as to the card, because on a `.metacool` the
   * drawer is the only surface a profile has: there is no Annotations panel for
   * it to be a row on (§8.5), so the row's export row does not exist and §18.7's
   * *bigWig for a signal, bedGraph, BED, TSV, PNG and vector PDF* would be a
   * claim this app did not keep on that layout. One implementation for both,
   * rather than the drawer growing a second copy of the writers and a second
   * opinion about where a bin ends.
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
  private async writeProfile(
    output: ProfileOutput,
    provenance: Provenance,
    format: 'bigwig' | 'bedgraph',
    grid: readonly BedGraphContig[],
    name = exportBaseName(output.label),
  ): Promise<void> {
    const stamp = fileStamp(new Date())
    if (format === 'bedgraph') {
      downloadBlob(
        new Blob([profileToBedGraph(output, grid, provenance)], { type: 'text/plain' }),
        `${name}-${stamp}.bedGraph`,
      )
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
    downloadBlob(blob, `${name}-${stamp}.bw`)
  }

}

/**
 * What a form needs to know about the loaded files, as one string.
 *
 * Id, kind and status, in order — the three things `candidatesFor` filters on to
 * decide what a task may be run against. A colour, a height, an edge and a name
 * are all absent on purpose: none of them changes the answer, and the first
 * fires the store on every tick of a colour drag while the last fires on every
 * keystroke of a rename.
 *
 * The cost of leaving the *label* out is a dropdown that goes on showing the old
 * name until something else changes — which is a cosmetic lag measured against
 * refilling every control, including a column list that reads four hundred
 * features, once per keystroke. If that lag ever matters, the fix is to debounce
 * a rename rather than to widen this.
 */
export function entrySignature(store: AnnotationStore): string {
  return store.entries.map((entry) => `${entry.id}:${entry.kind}:${entry.status}`).join('|')
}
