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
 */

import type { AnnotationClient } from '../annotations/worker/client'
import type { BinVector, BinVectorContig } from '../annotations/worker/binVector'
import { defaultStyle, emptyPlacement } from '../annotations/types'
import type { AnnotationEntry, ComputedSource } from '../annotations/types'
import type { AnnotationStore } from '../annotations/store'
import { el } from '../ui/dom'
import { downloadBlob, exportBaseName, fileStamp } from '../ui/export'
import { AnalysisDrawer } from '../ui/AnalysisDrawer'
import { AnalysisPanelCard } from '../ui/AnalysisPanelCard'
import { SyntheticCard, syntheticEntry, type SyntheticFormat } from '../ui/SyntheticCard'
import type { SourceSpec } from '../worker/protocol'
import { TASKS, tasksFor } from './registry'
import { AnalysisRunner, type RunnerHost } from './runner'
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
  /** How the analysis worker should mount the file; `null` before anything is open. */
  source(): { uri: string; source: SourceSpec } | null
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
  /** The worker a bin vector is registered with, so `sample` can answer for it. */
  annotations(): AnnotationClient | null
  /** The assembly, for the two writers that lay a vector out over it. */
  contigs(): BedGraphContig[]
  /** A panel's availability changed, or a row needs repainting. */
  changed(): void
}

/** A finished profile, held for as long as an export could ask for it. */
interface HeldProfile {
  output: ProfileOutput
  provenance: Provenance
  task: string
}

/** The same, for a called interval set. */
interface HeldIntervals {
  output: IntervalsOutput
  provenance: Provenance
  task: string
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
      vector: (entryId) => this.binVector(entryId),
      annotations: () => this.host.annotations(),
      contigLengths: () => {
        const out: Record<string, number> = {}
        for (const contig of this.host.contigs()) out[contig.name] = contig.length
        return out
      },
      finished: (task, result) => this.adopt(task, result),
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
    })
    this.drawerEl = this.drawer.el

    const store = host.store()
    this.synthetic =
      store === null
        ? null
        : new SyntheticCard({
            store,
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
  private adopt(task: AnalysisTask, result: TaskResult): void {
    rememberParams(result.provenance.framing.uri, task.id, result.provenance.params)

    const store = this.host.store()
    const profiles = result.outputs.filter(
      (output): output is ProfileOutput => output.kind === 'profile',
    )
    const intervals = result.outputs.filter(
      (output): output is IntervalsOutput => output.kind === 'intervals',
    )
    if (profiles.length === 0 && intervals.length === 0) return

    if (store === null) {
      // §8.5: a file with a genome layer carries no annotations, so there is no
      // card for a lane to be a row on. Said rather than dropped — a task that
      // produced a track and appears to have produced nothing is worse than one
      // that explains where the track went.
      this.drawer.refresh()
      return
    }

    for (const output of intervals) this.adoptIntervals(task, result, output, store)

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
      const entry = syntheticEntry(output, source, output.colour ?? store.nextColour())
      // `begin` is the one door every row goes through, and it opens them
      // `loading`; the vector is already in hand, so this one is ready the
      // moment the worker has been told about it — the same two-step the 4C
      // lane takes in `ui/viewpoint.ts`.
      store.begin({
        card: 'synthetic',
        kind: 'track',
        id: entry.id,
        label: entry.label,
        source,
        placement: entry.placement,
        style: entry.style,
      })
      this.profiles.set(entry.id, {
        output,
        provenance: result.provenance,
        task: task.id,
      })
      this.register(entry.id, output)
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
  ): void {
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
    const id = `analysis:${task.id}:${output.id}`
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
      label: output.label,
      source,
      placement: emptyPlacement(),
      style: defaultStyle(kind, colour),
    })
    store.update(id, { status: 'ready', payload: output.payload })
    this.intervals.set(id, { output, provenance: result.provenance, task: task.id })
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
  private register(entryId: string, output: ProfileOutput): void {
    const client = this.host.annotations()
    if (client === null) return
    const contigs: BinVectorContig[] = this.host.contigs().map((contig) => ({
      name: contig.name,
      startBin: contig.startBin,
      bins: contig.bins,
      length: contig.length,
    }))
    const vector: BinVector = {
      binsize: output.binsize,
      firstBin: output.extent[0],
      // A copy, because the worker takes ownership of what it is sent and this
      // module still needs the numbers for an export.
      values: output.values.slice(),
      contigs,
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

    const contigs = this.host.contigs()
    if (format === 'bedgraph') {
      downloadBlob(
        new Blob([profileToBedGraph(held.output, contigs, held.provenance)], {
          type: 'text/plain',
        }),
        `${base}-${stamp}.bedGraph`,
      )
      return
    }

    // The one export that can genuinely fail — a browser with no
    // `CompressionStream` still produces a legal file, but a vector that does
    // not line up with the assembly is a caller bug and throws.
    const blob = await writeBigWig({
      contigs: contigs.map((contig) => ({ name: contig.name, length: contig.length })),
      values: held.output.values,
      firstBin: held.output.extent[0],
      binsize: held.output.binsize,
    })
    downloadBlob(blob, `${base}-${stamp}.bw`)
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
