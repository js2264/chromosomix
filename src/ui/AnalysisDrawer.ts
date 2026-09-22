/**
 * The workspace: parameters, a price, a Run, progress, results and exports.
 *
 * **It is not a modal and must not become one** (§18.1). The dialogs in §5 are
 * questions; this is a place to work, and two of the three things `Modal` does
 * are ways of getting in the way of one: it takes the keyboard, which is how
 * this app is driven, and it dismisses on a stray click outside itself, after a
 * forty-second scan. So this class watches for no outside click and never
 * touches `App.modal` — every shortcut keeps working behind it, which is what
 * makes panning the map while reading a pileup an ordinary thing to do rather
 * than a mode to leave first.
 *
 * **Escape closes it, and that is not the modal's Escape.** A modal's Escape
 * cancels the question and throws the answer away; this one puts the panel down
 * and leaves everything running — the same thing the ✕ does, said with the key
 * every other overlay in this application is dismissed by. Nothing is lost by
 * pressing it: the run continues, the panel row goes on reporting it, and
 * re-opening the task brings back the form and the figures. Held to two rules so
 * that it stays a dismissal rather than becoming a mode. It fires in the
 * **bubble** phase and skips an event something else has already handled, so a
 * marquee on the map, a caret in the legend and a search box's own hit list all
 * keep the Escape they answer first; and a caret inside one of the drawer's own
 * fields keeps it too, because a reader abandoning a half-typed anchor means
 * that field and not the panel around it.
 *
 * It **overlays** the content and the two right columns rather than joining the
 * flex row, and that is arithmetic rather than taste: at three quarters of the
 * window there is nothing left to squeeze, so a fourth flex item would push the
 * map to a sliver and then have to push it back. The stylesheet does the
 * positioning; what is left here is the width, which is dragged from the left
 * edge through the same `resizeHandle` the columns use and remembered like
 * theirs.
 *
 * Two things about a result are contract rather than presentation, and both are
 * visible in this file:
 *
 * **A result is a record, and its framing is a snapshot** (§18.4). Panning after
 * a run does not change a finished pileup, so the header states the framing the
 * numbers belong to, marks it when the view has moved away from it, and offers
 * to take a new snapshot rather than quietly recomputing against one the reader
 * did not ask for.
 *
 * **A per-bin result is a lane, not a picture** (§18.5). A profile is therefore
 * not drawn here *when there is a lane for it*: it goes to the Synthetic tracks
 * card, where it inherits colour, rename, limits, autoscale, four edges, the
 * tooltip, the 1D browser and the vector figure by being the same object a
 * bigWig is. What this drawer shows for one is a sentence saying where it went,
 * because a drawer that appeared to produce nothing would be a bug report.
 *
 * **…and a picture when there is not.** A `.metacool` carries no annotations at
 * all (§8.5), so it has no Tracks card, no Synthetic tracks card and nowhere for
 * a lane to be a row — and there the sentence was a bug report of its own,
 * pointing a reader at a card that is not on screen while the numbers went
 * nowhere. Coverage and marginals, diamond insulation and MAG purity are all
 * offered on a metagenome and all produce per-bin vectors, so on that file this
 * drawer draws the profile itself ({@link profileFigure}) and carries the
 * exports the card would have carried: bigWig, bedGraph and TSV beside the PNG
 * and the vector PDF every other figure here has. §18.7's *every one of them
 * exports* holds on both layouts, which is what it claims.
 *
 * Every figure here draws through a `CanvasRenderingContext2D` and nothing else,
 * which is the whole reason the PDF export below is four lines: the same `draw`
 * that filled the canvas fills a {@link VectorPage}, so the file a reader
 * downloads is the figure that was on screen by construction rather than by
 * care.
 */

import { sameRecipe, type AnalysisRunner, type JobState } from '../analysis/runner'
import {
  defaultParams,
  type AnalysisContext,
  type AnalysisFraming,
  type AnalysisTask,
  type CostEstimate,
  type IntervalsOutput,
  type ParamValue,
  type Params,
  type ProfileOutput,
  type Provenance,
  type TaskOutput,
  type TaskResult,
} from '../analysis/types'
import { outputToTsv, provenanceLines, tsvName } from '../analysis/write/tsv'
import { cliCommandFor } from '../analysis/cliCommand'
import { taskById } from '../analysis/registry'
import { combineResults } from '../analysis/combine'
import { figureBlock } from '../figures/FigureBlock'
import type { MapId } from '../annotations/placement'
import type { RunTarget } from '../analysis/runner'
import type { CurveOutput } from '../analysis/types'

/**
 * The tab that is not a map: every map's curves on one axis.
 *
 * A sentinel rather than `null`, because `null` already means *no choice yet*
 * and the two lead to different pictures — the first map's, and all of them.
 */
const ALL_MAPS = '\u0000all-maps' as const
import { formatIntervals } from '../annotations/export'
import { writeBed3d } from '../annotations/g3d'
import { recallParams, rememberParams } from '../analysis/memory'
import { durationText, stopPromise } from './AnalysisPanelCard'
import { runClock } from '../units'
import { profileCurve, profileFigure, type PlotFigure } from './analysisPlots'
import { button, el, fmt } from './dom'
import { canvasToPng, copyTextToClipboard, downloadBlob, fileStamp, scaleForDpi } from './export'
import { icon, iconButton } from './icons'
import { ParamForm } from './ParamForm'
import { resizeHandle } from './resizeHandle'
import { VectorPage } from './vector'

/**
 * Where the dragged width is kept.
 *
 * `localStorage` and not `UiMemory`, for the reason `SidePanel` gives about the
 * three columns: how wide a reader likes their workspace is a preference about
 * this window, not a train of thought about this file.
 */
const WIDTH_KEY = 'metacooler-viewer:analysis-drawer:width'

/**
 * Where an output that is not a picture went, as the four answers there are.
 *
 * A key rather than the sentence itself, because it is what decides which
 * outputs of one run share a block: two lanes are one note and a lane beside an
 * overlay is two, and comparing keys is how that is said.
 */
type Elsewhere = 'lane' | 'structure' | 'overlay' | 'loose'

/** Below this there is no room for a figure and its axis labels at once. */
const MIN_WIDTH = 380
const DEFAULT_FRACTION = 0.75
/** Not 1: a sliver of the map showing is what says this is a drawer. */
const MAX_FRACTION = 0.95

/**
 * The resolution an exported figure is *redrawn* at.
 *
 * 300 dpi because that is what a journal asks for, and redrawn rather than
 * scaled up because these plots are paths — the same argument `ui/export.ts`
 * makes for the map. There is no chooser beside it as there is for the map: a
 * drawer figure is a few hundred rectangles and some text, so the file is small
 * at print resolution and a control asking a reader to think about dots per inch
 * would be a control earning nothing.
 */
const FIGURE_EXPORT_DPI = 300

/** Distinguishes the ids of two drawers mounted at once — a session, and a test. */
let drawers = 0

export interface AnalysisDrawerOptions {
  runner: AnalysisRunner
  context(): AnalysisContext | null
  /** The framing a run started now would be a record of (§18.4). */
  framing(): AnalysisFraming | null
  /** The close button was pressed. The owner clears its own idea of what is open. */
  onClose(): void
  /**
   * Whether this file has an Annotations panel for a lane or an overlay to
   * become a row on.
   *
   * `false` on a `.metacool` (§8.5) and that is the whole of what it means: the
   * outputs that are not pictures have nowhere to go, so this drawer draws and
   * exports them itself rather than describing a card that is not on screen.
   */
  hasLanes(): boolean
  /**
   * Write a per-bin profile out as a file a genome browser opens.
   *
   * Here rather than in this file because it needs the assembly — a bigWig
   * carries a chrom list and a bedGraph is written in genomic coordinates —
   * which is the workspace's to know. Only called while {@link hasLanes} is
   * `false`; otherwise the row's own export row is the place for it.
   */
  writeProfile(
    output: ProfileOutput,
    provenance: Provenance,
    format: 'bigwig' | 'bedgraph',
  ): Promise<void>
}

// ---------------------------------------------------------------------------
// Width
// ---------------------------------------------------------------------------

/**
 * The stored width, or `null`.
 *
 * Read exactly as `SidePanel` reads a column's, because a stored width outlives
 * the build that wrote it and is untrusted input like the URL hash. The one
 * difference is where the clamp happens: a column's bounds are constants and can
 * be applied on the way in, while this one's maximum is a fraction of a window
 * that has since been resized — so the raw number is kept and clamped at every
 * paint.
 */
function readStoredWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function writeStoredWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(WIDTH_KEY)
    else window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)))
  } catch {
    /* a browser that refuses storage still resizes correctly for this session */
  }
}

// ---------------------------------------------------------------------------
// Small readings
// ---------------------------------------------------------------------------

/** Whether a recalled value is something a parameter may legally hold. */
function isParamValue(value: unknown): value is ParamValue {
  if (value === null) return true
  const kind = typeof value
  if (kind === 'number' || kind === 'string' || kind === 'boolean') return true
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * What this file and this task were last run with, over the descriptor's defaults.
 *
 * Key by key rather than wholesale, because what comes back is untrusted: it was
 * written by whichever build was open when the reader last pressed Run, and a
 * task that has since gained, lost or retyped a parameter must not be handed the
 * old shape. A key the descriptor no longer has is dropped; one it has gained
 * keeps its default.
 *
 * Through `analysis/memory.ts` rather than through a scope of this module's own,
 * and the difference is not stylistic. This used to read and write
 * `analysis:<task id>` — one storage scope per task — while `analysis/memory.ts`
 * wrote every task's parameters into the single `analysis:params` scope on Run.
 * Two schemes for one thing, and the split fell exactly where that module's
 * docstring says it would: `state/SessionConfig.ts` gathers a session by reading
 * a **fixed list** of scopes, a scope named after a task id cannot be on that
 * list, and so an exported session carried the parameters of every task and put
 * none of them back on import. One scope, one reader, and the fixed list is
 * complete again.
 */
function recallParamsFor(task: AnalysisTask, uri: string): Params {
  const out: Record<string, ParamValue> = { ...defaultParams(task.params) }
  const held = recallParams(uri, task.id)
  if (held === null) return out
  for (const spec of task.params) {
    const value = held[spec.key]
    if (isParamValue(value)) out[spec.key] = value
  }
  return out
}

/**
 * The price, as one line beside **Run**.
 *
 * The note is already worded for a human, and the two numbers are appended
 * rather than folded into it because §18.6 asks for the pre-flight figure in
 * *requests and bytes* — the same two numbers the genome × genome scan states
 * before it starts. `null` means there are none to state, which is what a local
 * file answers, and a `0 requests` beside a free task would be an answer to a
 * question nobody asked.
 *
 * **The note's terminal full stop is stripped before the join**, and that is one
 * line rather than an edit to nine tasks: a note that ends its sentence properly
 * came out as `… 1 block read from the file. · 1 request`, a full stop followed
 * by a middle dot, in the one line a reader checks before spending compute.
 * Fixed here because the join is here; a task that writes a sentence should not
 * have to know what will be appended to it.
 */
function costText(estimate: CostEstimate): string {
  const parts = [estimate.note.replace(/\.\s*$/, '')]
  if (estimate.requests !== null && estimate.requests > 0) {
    parts.push(`${fmt.int(estimate.requests)} request${estimate.requests === 1 ? '' : 's'}`)
  }
  if (estimate.bytes !== null && estimate.bytes > 0) parts.push(fmt.bytes(estimate.bytes))
  return parts.join(' · ')
}

/** Whether a shown result was computed over the framing the view has now. */
function framingHolds(provenance: Provenance, framing: AnalysisFraming): boolean {
  // Through `sameRecipe`, with the result's own parameters on both sides so that
  // only the framing half of the comparison can fail. The runner exports it for
  // exactly this: two spellings of "is this the same question" would eventually
  // disagree, and the one that is wrong would be the one nobody tests.
  return sameRecipe(provenance, { params: provenance.params, framing })
}

/**
 * Whether a figure can be redrawn into a raster or onto a page.
 *
 * A table is DOM and a plot is a canvas, so only one of the two has a `draw` to
 * hand a different context to. Asked of the figure rather than of the output
 * kind that produced it, so the day a third figure kind appears the compiler
 * asks the question at the one place that has to answer it.
 */
/**
 * Whether a control answers Escape itself.
 *
 * A text box does — the key is how a half-typed value is abandoned — and a
 * button, a tickbox or a slider does not, so a reader who has just pressed Run
 * and left the focus there gets the dismissal they meant. `select` is included:
 * an open dropdown closes on Escape and closing the panel under it would take
 * the list away mid-choice.
 */
function takesEscape(node: HTMLElement): boolean {
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true
  if (!(node instanceof HTMLInputElement)) return node.isContentEditable
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(node.type)
}

/**
 * The line under the run row: which step is running, or why the last one
 * stopped.
 *
 * A composite runs several things in sequence and the honest answer to "why is
 * this taking so long" is which of them is running — the runner's note already
 * says so, and this is where it is read. A **cancelled** job says nothing at
 * all: the reader pressed the button, and a sentence telling them what they just
 * did is the kind of message that trains people to stop reading messages.
 */
/**
 * When a stored run finished, as a clock time.
 *
 * The time and not the date, because the history is this session's: eight runs
 * of one task all happened this afternoon, and a date beside each of them would
 * be eight copies of today. Through `units.runClock`, which is the one place
 * this app turns an instant into six characters — this file used to hold a
 * second copy of that arithmetic and print the raw ISO string two hundred lines
 * below it, so the same field read `20:49:46` on the run stepper and
 * `2026-09-20T20:49:46.151Z` on the result line.
 */
function finishedAt(result: TaskResult): string {
  return runClock(result.provenance.createdAt)
}

/**
 * What differs between two runs of one task, in the reader's own words.
 *
 * The sentence the history needs and nothing else on screen carries. Two pileups
 * are two pictures *because* something was changed, and a stepper that offered
 * `run 2 of 5` and no more would make a reader open the provenance of each in
 * turn to find out which was which.
 *
 * Labels rather than keys — `Half-width`, not `window` — because those are the
 * words the form used when the number was typed. Parameters the task no longer
 * declares are skipped: a stored run may predate a rename, and a difference in a
 * key nobody can see is not a difference a reader can act on.
 */
function runDifference(shown: TaskResult, latest: TaskResult, task: AnalysisTask): string {
  if (shown === latest) return 'The run on screen'
  const parts: string[] = []
  for (const spec of task.params) {
    const before = shown.provenance.params[spec.key]
    const after = latest.provenance.params[spec.key]
    if (paramText(before) === paramText(after)) continue
    parts.push(`${spec.label}: ${paramText(before)} (latest: ${paramText(after)})`)
  }
  const when = `Finished ${finishedAt(shown)}.`
  return parts.length === 0
    ? `${when} The same parameters as the latest run.`
    : `${when} ${parts.join(' · ')}`
}

/** One parameter value, as a string a reader recognises. */
function paramText(value: ParamValue | undefined): string {
  if (value === undefined || value === null || value === '') return '—'
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join(', ')
  return String(value)
}

function runNote(state: JobState): Array<HTMLElement | string> {
  switch (state.status) {
    case 'running':
      // Decoration beside a sentence that already says what is happening, so
      // it is hidden from the reader who is being read to.
      return [
        el('span', { class: 'analysis-spinner', attrs: { 'aria-hidden': 'true' } }),
        state.note === '' ? 'working' : state.note,
      ]
    case 'queued':
      return ['waiting for the job in front of it']
    case 'failed':
      return [el('span', { class: 'inline-error', text: state.message })]
    default:
      return []
  }
}

/** A figure's box on screen, in CSS pixels — what the export redraws into. */
function figureBox(host: HTMLElement): { width: number; height: number } {
  const rect = host.getBoundingClientRect()
  return {
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  }
}

/**
 * The export filename, with the extension swapped.
 *
 * `tsvName` owns the rule — which parts, in which order, and when the output
 * segment is dropped because it would repeat the task's own name — and it is
 * called rather than copied. A PNG of the same output must land beside its TSV
 * in a directory listing, and two implementations of one naming rule is how one
 * of them stops doing that.
 */
/** A label as a filename: lower case, words joined by hyphens, nothing else. */
function plainName(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'figure'
  )
}

function exportName(output: TaskOutput, provenance: Provenance, stamp: string, ext: string): string {
  return tsvName(provenance.task, output, stamp).replace(/\.tsv$/, `.${ext}`)
}

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------

export class AnalysisDrawer {
  /** The drawer itself, to be parented into the shell's drawer slot. */
  readonly el: HTMLElement

  private readonly titleEl = el('h2', { class: 'analysis-drawer-title' })
  private readonly framingEl = el('span', { class: 'analysis-framing' })
  private readonly recomputeButton: HTMLButtonElement
  private readonly formSlot = el('div', { class: 'analysis-form' })
  private readonly runButton: HTMLButtonElement
  /**
   * Run this task on every map in the deck — hidden while there is one map.
   *
   * Beside Run rather than instead of it, because the two are different
   * questions and the reader has already answered which by opening a deck:
   * *this* picture, or all of them. Hidden rather than disabled on a session
   * with one map, since a control offering to do something to a set of one is a
   * control a reader has to work out.
   */
  private readonly runAllButton: HTMLButtonElement
  private readonly cancelButton: HTMLButtonElement
  private readonly costEl = el('span', { class: 'analysis-cost' })
  private readonly progressFill = el('div', { class: 'analysis-progress-fill' })
  private readonly progressEl: HTMLElement
  private readonly noteEl = el('div', { class: 'analysis-note hidden' })
  private readonly recordEl: HTMLElement
  private readonly recordNote = el('span', { class: 'analysis-note' })
  private readonly notesEl = el('ul', { class: 'analysis-notes hidden' })
  private readonly outputsEl = el('div', {
    // The body is a flex column with a gap and these blocks want the same one,
    // but they are replaced as a group and so need a parent of their own to be
    // replaced inside. Stated here rather than as a class, because a rule whose
    // whole content is "the same as the box around it" is a rule that will be
    // read as meaning something.
    style: { display: 'flex', flexDirection: 'column', gap: '0.8rem' },
  })
  /**
   * One tab per map that has a result for this task, plus *all maps*.
   *
   * Hidden with fewer than two, which is every session that is not a deck —
   * a tab strip over one thing is furniture.
   */
  private readonly mapsEl = el('div', { class: 'analysis-maps hidden' })
  /**
   * *Run 2 of 5* — the stepper back through earlier runs of this task.
   *
   * Hidden until there is more than one, like the map strip above it and for the
   * same reason: a control offering a choice of one is furniture.
   */
  private readonly runsEl = el('div', { class: 'analysis-runs hidden' })
  /** Where an export that could not be written says so. */
  private readonly statusEl = el('div', { class: 'analysis-note hidden' })

  private readonly unsubscribe: () => void
  private current: AnalysisTask | null = null
  private form: ParamForm | null = null
  private params: Params = {}
  private figures: Array<{ destroy(): void }> = []
  /** The result the output blocks were built from, compared by identity. */
  private drawn: TaskResult | null = null
  /**
   * `copy CLI command`, whose enabled state is a property of the task.
   *
   * Built once and repainted, like {@link runButton} beside it, because a task
   * that reads a track cannot be run from a shell at all and the button has to
   * say so rather than hand over a line the command rejects
   * (`analysis/cliCommand.ts`).
   */
  private readonly cliButton: HTMLButtonElement
  /**
   * Which map's result is on screen — a `MapId`, or `ALL_MAPS` for the overlay.
   *
   * Held per task, because walking a deck's panels on one task and then opening
   * another should not put the reader back on panel one: the choice is about the
   * *comparison* they are making, and that survives changing which quantity they
   * are comparing.
   */
  private readonly chosenMap = new Map<string, MapId | typeof ALL_MAPS>()
  /**
   * Which run of this task is on screen: 0 is the newest, held per task.
   *
   * Per task rather than per task and map, and reset by {@link syncMaps} when
   * the map changes, because *the run before last* is a thing a reader means
   * about one picture: carrying an index from panel one to panel four would land
   * them on whichever of panel four's runs happened to be third.
   */
  private readonly chosenRun = new Map<string, number>()
  /** Set while the combined figure is drawn, so the exports know what they are. */
  private combined = false
  /** The dragged width, or `null` for "however wide the default says". */
  private width: number | null = readStoredWidth()

  constructor(private readonly options: AnalysisDrawerOptions) {
    const id = `analysis-drawer-${drawers++}`
    this.titleEl.id = `${id}-title`

    this.recomputeButton = button('recompute here', () => this.run(), {
      class: 'btn btn-quiet',
      title:
        'Take a new snapshot of the framing and run again. The result on screen is a record of ' +
        'the view it was computed from, so it is left as it is until this finishes.',
    })
    this.runButton = button('run', () => this.run(), { class: 'btn' })
    // Its label is written in {@link paintRun}, because on a deck it names the
    // map — which changes under the drawer while it is open.
    // The same weight as `run` beside it, and not the quiet form. The two are
    // the same act at two scopes — one map, or every map — and a bordered
    // button next to a borderless one says the second is an afterthought, or a
    // link, rather than the other half of a choice the reader is making.
    this.runAllButton = button('run on all maps', () => this.runAll(), {
      class: 'btn hidden',
      title:
        'Run this task once per map on screen, one after another. Each result is filed against ' +
        'the map it was measured from, so a batch leaves a row per panel.',
    })
    // **Bordered, and beside Run.** It was a borderless `btn-quiet` after the
    // cost sentence, which put the one control that stops a forty-second scan at
    // the far end of a row of prose, in the weight this app uses for a link. The
    // principle is §5.4's, about a bar: a control styled differently from its
    // neighbours is a control a reader wonders about. Its sentence comes from
    // `stopPromise`, so the drawer and the panel row agree about what the press
    // does — and is set per task in {@link syncRun}, because the two venues stop
    // differently.
    this.cancelButton = button('cancel', () => this.cancel(), { class: 'btn' })
    // Bordered, like the copy beside it. These two are how a result leaves the
    // app for a methods section or a shell, and unbordered they read as captions
    // of the line above them (§18.7).
    this.cliButton = button('copy CLI command', () => this.copyCliCommand(), { class: 'btn' })
    this.progressEl = el('div', { class: 'analysis-progress' }, this.progressFill)
    this.recordEl = el(
      'div',
      { class: 'plot-icon-row hidden' },
      this.recordNote,
      button('copy provenance', () => this.copyProvenance(), {
        class: 'btn',
        title:
          'The task, its version, every parameter, the framing, the file and the build — the ' +
          'same lines every export carries at its head.',
      }),
      // The other half of the same fact, for the reader whose next file is the
      // second of two hundred. Whether it can be pressed, and what it says when
      // it cannot, are written in {@link paintCli} — both are properties of the
      // task the result came from rather than of the drawer.
      this.cliButton,
    )

    this.el = el(
      'div',
      {
        // `collapsed` is the stylesheet's own word for a column that is not
        // there, and it is reused rather than renamed: one class means one thing
        // across the four surfaces beside the map.
        class: 'analysis-drawer collapsed',
        attrs: { role: 'region', 'aria-labelledby': this.titleEl.id },
      },
      el(
        'div',
        { class: 'analysis-drawer-head' },
        this.titleEl,
        this.framingEl,
        this.recomputeButton,
        iconButton(
          'x',
          'Close the drawer. Anything running keeps running — the panel row says so.',
          () => this.close(),
          { class: 'btn-close', size: 14 },
        ),
      ),
      el(
        'div',
        { class: 'analysis-drawer-body' },
        this.formSlot,
        el(
          'div',
          { class: 'analysis-run' },
          this.runButton,
          this.runAllButton,
          // Directly after the buttons that start it, so the row reads as its
          // two actions and then its two readings: run · cancel · price · bar.
          // It used to sit after the cost sentence, where a reader looking for
          // the way to stop a scan had a line of prose to read first.
          this.cancelButton,
          // The price beside the button and before the bar that only exists
          // while it is running (§18.6): what a task costs is what decides
          // whether to press Run, so it is read on the way to the button and not
          // after it.
          this.costEl,
          this.progressEl,
        ),
        this.noteEl,
        this.recordEl,
        this.notesEl,
        this.mapsEl,
        this.runsEl,
        this.outputsEl,
        this.statusEl,
      ),
      this.handle(),
    )

    this.unsubscribe = options.runner.subscribe(() => this.refresh())
    window.addEventListener('keydown', this.onKeyDown)
  }

  // -------------------------------------------------------------------------
  // Opening and closing
  // -------------------------------------------------------------------------

  /**
   * Show one task, or nothing.
   *
   * Re-showing the task already open is a refresh rather than a rebuild: the
   * panel calls this on every click, and a reader who clicks the row they are
   * already reading should not lose the form they were half way through filling
   * in.
   */
  show(task: AnalysisTask | null): void {
    if (task !== null && this.current !== null && task.id === this.current.id) {
      this.refresh()
      return
    }
    this.teardown()
    this.current = task
    if (task === null) {
      this.el.classList.add('collapsed')
      return
    }
    this.params = defaultParams(task.params)
    this.el.classList.remove('collapsed')
    this.paintWidth()
    this.refresh()
  }

  get task(): AnalysisTask | null {
    return this.current
  }

  get isOpen(): boolean {
    return this.current !== null
  }

  /** Re-read the runner, the context and the framing, and repaint from them. */
  /**
   * Say which map Run is about, on a deck — with the star itself.
   *
   * `run` is a complete sentence while there is one map and is dangerously
   * incomplete beside five: the reader has one map starred and four not, the
   * difference between them is a small filled star in each heading, and a button
   * saying only `run` gives them nothing to check that against before they spend
   * a minute of compute. So the button carries **the same mark**, filled, rather
   * than the file's name — a name is longer than the button and would resize it
   * every time the star moved, and the mark is what the reader is already
   * reading the deck by.
   *
   * The name goes in the tooltip, where there is room for it and where somebody
   * who does not yet know what the star stands for will look next.
   *
   * Plain `run` on a single map, and deliberately not `run on ★`: there is no
   * star on screen for it to point at, and a mark standing for a choice nobody
   * has been offered is a control a reader has to go looking for.
   */
  private paintRun(task: AnalysisTask, maps: number): void {
    const target = maps < 2 ? null : this.options.runner.target()
    if (target === null) {
      this.runButton.replaceChildren('run')
      this.runButton.title = `Run ${task.title} on the open map.`
      return
    }
    this.runButton.replaceChildren('run on ', icon('star', { size: 12, class: 'run-star' }))
    this.runButton.title =
      `Run ${task.title} on ${target.label} — the starred map, which is the one every task ` +
      'measures. Move the star in a panel’s heading to measure another, or run on all of them.'
  }

  refresh(): void {
    const task = this.current
    if (task === null) return
    const context = this.options.context()
    this.titleEl.textContent = task.title
    this.syncForm(task, context)
    const across = this.options.runner.resultsFor(task.id)
    this.syncMaps(task, across)
    const chosen = this.chosenMap.get(task.id)
    const combined = chosen === ALL_MAPS && across.length > 1
    // Every run of this task on the map that is on screen, newest first. The
    // overlay has none: it is a fold of *one* result per map, so *the run before
    // last* is a question about a different object.
    const mapId = chosen === undefined || chosen === ALL_MAPS ? undefined : chosen
    const own = mapId === undefined ? [] : this.options.runner.runsOf(task.id, mapId)
    const runs = combined ? [] : own.length > 0 ? own : this.options.runner.runsOf(task.id)
    const at = Math.min(Math.max(0, this.chosenRun.get(task.id) ?? 0), Math.max(0, runs.length - 1))
    const result = combined ? null : (runs[at] ?? null)
    this.syncRuns(task, runs, at)
    if (combined) this.syncCombined(across)
    else this.syncOutputs(result)
    this.syncFraming(result ?? across[0]?.result ?? null)
    this.syncRun(task, context)
  }

  /**
   * The window or a column moved.
   *
   * Only the width needs saying: the figures inside own `ResizeObserver`s of
   * their own and redraw themselves, which is why they are wrappers around a
   * canvas rather than canvases.
   */
  relayout(): void {
    if (this.current !== null) this.paintWidth()
  }

  destroy(): void {
    this.unsubscribe()
    window.removeEventListener('keydown', this.onKeyDown)
    this.teardown()
    this.el.remove()
  }

  /**
   * Escape puts the drawer down — see the module docstring for why that is a
   * dismissal rather than a modal's cancel.
   *
   * A field is the one thing that outranks it. A reader who has typed half an
   * anchor into the 4C box and presses Escape means *that box*, and a panel that
   * vanished from under them would take the form with it — so a caret in one of
   * the drawer's own text controls keeps the key, and the second press, with the
   * field no longer interesting, closes as usual.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (this.current === null) return
    const active = document.activeElement
    if (active instanceof HTMLElement && this.el.contains(active) && takesEscape(active)) return
    event.preventDefault()
    this.close()
  }

  /**
   * Close, and say so.
   *
   * Both, and in that order: which task is open is the owner's fact — it is what
   * the panel's `active()` reads — but a close button that only reported the
   * press and left the drawer up would be a button whose effect depends on
   * somebody else's bookkeeping.
   */
  private close(): void {
    this.show(null)
    this.options.onClose()
  }

  private teardown(): void {
    this.form?.destroy()
    this.form = null
    this.clearFigures()
    this.outputsEl.replaceChildren()
    this.notesEl.replaceChildren()
    this.notesEl.classList.add('hidden')
    this.recordEl.classList.add('hidden')
    this.formSlot.replaceChildren()
    this.setStatus('')
    this.drawn = null
    this.params = {}
  }

  /**
   * The one line an export writes when it could not.
   *
   * Hidden when empty rather than left as an empty box: the drawer's body is a
   * flex column with a gap, so an element with no text is still a gap, and three
   * of those between the run row and the first figure read as a layout mistake.
   */
  private setStatus(text: string): void {
    this.statusEl.textContent = text
    this.statusEl.classList.toggle('hidden', text === '')
  }

  private clearFigures(): void {
    for (const figure of this.figures) figure.destroy()
    this.figures = []
  }

  // -------------------------------------------------------------------------
  // Width
  // -------------------------------------------------------------------------

  private handle(): HTMLElement {
    return resizeHandle({
      // A right-sider, so dragging left widens it. The drawer is not a column,
      // but the question the sign answers is the same one.
      side: 'right',
      what: 'Analysis drawer',
      width: () => this.widthNow(),
      resize: (px) => {
        this.width = px
        this.paintWidth()
      },
      // The *effective* width, not the raw one the pointer asked for. A drag
      // that ran past the right edge of the window would otherwise store a
      // number this window never honoured, and the drawer would jump to it on a
      // wider screen months later.
      commit: () => writeStoredWidth(this.widthNow()),
      reset: () => {
        this.width = null
        writeStoredWidth(null)
        this.paintWidth()
      },
    })
  }

  /** The body the drawer is laid over, which is what the fractions are of. */
  private bodyWidth(): number {
    const host = this.el.closest('.app-body') ?? this.el.parentElement
    const width = host?.getBoundingClientRect().width ?? 0
    return width > 0 ? width : window.innerWidth
  }

  private widthNow(): number {
    const body = this.bodyWidth()
    const max = Math.round(body * MAX_FRACTION)
    // The floor gives way to the ceiling rather than the other way round: on a
    // window narrower than the minimum, 95% of it is the honest answer and 380
    // pixels would hang off the edge.
    const floor = Math.min(MIN_WIDTH, max)
    return Math.max(floor, Math.min(max, this.width ?? Math.round(body * DEFAULT_FRACTION)))
  }

  private paintWidth(): void {
    this.el.style.width = `${this.widthNow()}px`
  }

  // -------------------------------------------------------------------------
  // The form
  // -------------------------------------------------------------------------

  /**
   * Build the form, or hand it the context it should be reading now.
   *
   * Rebuilt only when the *task* changes. A context change — a track dropped, a
   * file finishing its parse — is given to the existing form, which repairs its
   * entry dropdowns in place and leaves every number the reader typed alone.
   */
  private syncForm(task: AnalysisTask, context: AnalysisContext | null): void {
    if (context === null) return
    if (this.form !== null) {
      this.form.setContext(context)
      return
    }
    this.params = recallParamsFor(task, context.uri)
    const form = new ParamForm({
      specs: task.params,
      context,
      value: this.params,
      onChange: (next) => this.onParams(next),
    })
    this.form = form
    // Read back what the entry resolution decided. The form deliberately fires
    // no `onChange` from its constructor, so this is the only place the star's
    // choices reach the estimate.
    this.params = form.value
    this.formSlot.replaceChildren(form.el)
  }

  private onParams(next: Params): void {
    this.params = next
    const task = this.current
    const context = this.options.context()
    if (task === null || context === null) return
    // Remembered on every edit rather than on Run, so that reproducing a figure
    // is opening the session and pressing Run (§18.2) — including the run the
    // reader configured, thought better of, and came back to.
    rememberParams(context.uri, task.id, next)
    this.syncRun(task, context)
  }

  // -------------------------------------------------------------------------
  // Running
  // -------------------------------------------------------------------------

  private run(): void {
    const task = this.current
    if (task === null) return
    this.setStatus('')
    // Back to the newest, because the one about to arrive *is* the newest and a
    // reader who pressed Run while reading run 3 would otherwise watch their
    // result finish somewhere they are not looking.
    this.chosenRun.delete(task.id)
    this.options.runner.run(task, this.params)
    this.refresh()
  }

  /**
   * The same task, once per map, in reading order.
   *
   * The runner queues them rather than starting them together: the worker mounts
   * one file at a time, and five h5wasm instances with five dense blocks live at
   * once is the moment a tab can least afford it. Cancel stops the batch where
   * it has reached, which is the honest meaning of a queue.
   */
  private runAll(): void {
    const task = this.current
    if (task === null) return
    this.setStatus('')
    this.chosenRun.delete(task.id)
    // **Awaited**, and this is the whole of the fix. A companion opens to draw a
    // picture; the two tables an analysis needs are a further pair of reads it
    // makes only when starred or batched (`panels/MapPanel.ts`). So the
    // synchronous list found a freshly opened deck's fourth map missing, ran the
    // three that were ready, and left the fourth reading — with nothing on
    // screen saying so, because a result that never came looks exactly like a
    // task that had nothing to say. Pressing again worked, which made a timing
    // question look like a question about the file.
    //
    // The button is held down while it waits rather than left live: two presses
    // would queue the batch twice, and the second `runAll` cancels the first
    // mid-flight. `refresh` puts it back, whichever way this ends.
    this.runAllButton.disabled = true
    void this.options.runner
      .readyTargets()
      .then((targets) => {
        // The reader may have moved on — closed the drawer, chosen another task
        // — while the tables were read. Running what they have stopped looking
        // at is worse than not running it.
        if (this.current !== task) return
        this.options.runner.runAll(task, this.params, targets)
      })
      .finally(() => this.refresh())
  }

  private cancel(): void {
    if (this.current !== null) this.options.runner.cancel(this.current.id)
  }

  private syncRun(task: AnalysisTask, context: AnalysisContext | null): void {
    const state = this.options.runner.stateOf(task.id)
    const busy = state.status === 'running' || state.status === 'queued'
    const estimate = context === null ? null : task.estimate(context, this.params)
    const refusal =
      context === null
        ? 'This view has no contact map to run against.'
        : estimate !== null && estimate.refusal !== undefined && estimate.refusal !== ''
          ? estimate.refusal
          : null

    this.runButton.disabled = busy || refusal !== null
    // The button appears only where there is more than one map to run on, and
    // is priced by the same refusal: a task this file cannot answer cannot be
    // answered five times either.
    // Every map in the grid, ready or not: the batch waits for the ones still
    // opening ({@link runAll}), so counting only the ready ones offered "run on
    // all 3 maps" over a deck of four and then ran four.
    const maps = this.options.runner.targetCount()
    this.paintRun(task, maps)
    this.runAllButton.classList.toggle('hidden', maps < 2)
    this.runAllButton.disabled = busy || refusal !== null
    this.runAllButton.textContent = `run on all ${maps} maps`
    if (refusal !== null) {
      // In the price's place, not beside it. A refusal names the bin count, the
      // bytes and the way out (§18.6), and a cost estimate underneath it would
      // be a price for something that is not going to happen.
      this.costEl.className = 'analysis-refusal'
      this.costEl.textContent = refusal
    } else {
      this.costEl.className =
        estimate !== null && estimate.class === 'scan' ? 'analysis-cost is-scan' : 'analysis-cost'
      this.costEl.textContent = estimate === null ? '' : costText(estimate)
    }

    this.cancelButton.classList.toggle('hidden', !busy)
    this.cancelButton.title = `Stop this job. ${stopPromise(task.venue)}`
    const determinate = state.status === 'running' && state.total > 0
    this.progressEl.classList.toggle('hidden', !determinate)
    if (determinate && state.status === 'running') {
      this.progressFill.style.width = `${Math.min(100, (state.done / state.total) * 100).toFixed(1)}%`
    }

    const note = runNote(state)
    this.noteEl.replaceChildren(...note)
    this.noteEl.classList.toggle('hidden', note.length === 0)
  }

  // -------------------------------------------------------------------------
  // Which map's figures are on screen
  // -------------------------------------------------------------------------

  /**
   * The tab strip: one map per tab, `all maps` last, arrows either side.
   *
   * Both navigations are here because they answer different questions. A reader
   * checking whether panel three looks like panel two wants **next** and wants
   * to press it repeatedly without aiming; a reader who knows they want the
   * fourth library wants to click its name. Offering only the first makes a deck
   * of six tedious, and only the second makes a comparison a series of small
   * aiming tasks.
   */
  private syncMaps(
    task: AnalysisTask,
    across: ReadonlyArray<{ target: RunTarget; result: TaskResult }>,
  ): void {
    if (across.length < 2) {
      this.mapsEl.classList.add('hidden')
      this.mapsEl.replaceChildren()
      // Not remembered: a task whose deck has gone back to one map has one
      // answer, and a stale `ALL_MAPS` would draw an overlay of one line.
      this.chosenMap.delete(task.id)
      return
    }
    const stops: Array<MapId | typeof ALL_MAPS> = [
      ...across.map((entry) => entry.target.map),
      ALL_MAPS,
    ]
    const chosen = this.chosenMap.get(task.id) ?? stops[0]
    const go = (to: MapId | typeof ALL_MAPS): void => {
      this.chosenMap.set(task.id, to)
      // A different map is a different list of runs — see {@link chosenRun}.
      this.chosenRun.delete(task.id)
      // Forced: the next `refresh` compares results by identity, and stepping
      // from one map to another can land on the *same* object where a composite
      // reused an upstream. Without this the tab lights up and the figures do
      // not change, which reads as the tab being broken.
      this.drawn = null
      this.refresh()
    }
    const step = (by: number): void => {
      const at = stops.indexOf(chosen)
      go(stops[(at + by + stops.length) % stops.length])
    }

    this.mapsEl.classList.remove('hidden')
    this.mapsEl.replaceChildren(
      iconButton('chevron-left', 'The previous map', () => step(-1), { class: 'btn-quiet' }),
      ...across.map((entry) =>
        button(entry.target.label, () => go(entry.target.map), {
          class: `btn btn-quiet analysis-map${entry.target.map === chosen ? ' is-on' : ''}`,
          title: `The result measured on ${entry.target.label}`,
        }),
      ),
      button('all maps', () => go(ALL_MAPS), {
        class: `btn btn-quiet analysis-map${chosen === ALL_MAPS ? ' is-on' : ''}`,
        title: 'Every map\u2019s curves on one axis — the comparison the deck was opened for',
      }),
      iconButton('chevron-right', 'The next map', () => step(1), { class: 'btn-quiet' }),
    )
  }

  /**
   * The stepper back through earlier runs of this task on this map.
   *
   * **Because a result is expensive and pressing Run used to destroy one.** A
   * pileup over forty thousand anchors is a minute of range requests, and the
   * commonest thing anybody does with this catalogue is run a task, change one
   * number, run it again — at which point the first answer, and the parameters
   * that produced it, were simply gone. There was nothing to compare against and
   * nothing to go back to; the only way to see the previous figure again was to
   * remember the settings and pay for it a second time.
   *
   * Newest first, so *the run on screen* is where the drawer opens and the
   * stepper reads backwards from it — which is the direction the question is
   * asked in. The buttons are named rather than bare chevrons because *left* has
   * no meaning over a list ordered by time: `older` and `newer` are the two
   * words a reader has in mind.
   *
   * The line between them says which run it is and when it finished, and its
   * tooltip says **what differs** from the run on top — the reason the two
   * pictures are two pictures, which nothing on screen would otherwise state.
   */
  private syncRuns(task: AnalysisTask, runs: readonly TaskResult[], at: number): void {
    if (runs.length < 2) {
      this.runsEl.classList.add('hidden')
      this.runsEl.replaceChildren()
      return
    }
    const go = (to: number): void => {
      this.chosenRun.set(task.id, Math.max(0, Math.min(runs.length - 1, to)))
      // Forced, for {@link syncMaps}'s reason: `refresh` compares results by
      // identity, and a step that landed on the same object would light the
      // button and leave the figures alone.
      this.drawn = null
      this.refresh()
    }
    const older = button('older', () => go(at + 1), {
      class: 'btn btn-quiet',
      title: 'The run before this one, with the figures it produced',
    })
    older.disabled = at >= runs.length - 1
    const newer = button('newer', () => go(at - 1), {
      class: 'btn btn-quiet',
      title: 'Back towards the most recent run',
    })
    newer.disabled = at <= 0
    const latest = button('latest', () => go(0), {
      class: 'btn btn-quiet',
      title: 'The most recent run of this task',
    })
    latest.disabled = at === 0

    this.runsEl.classList.remove('hidden')
    this.runsEl.replaceChildren(
      icon('rotate-cw', { size: 13, class: 'analysis-runs-mark' }),
      older,
      el('span', {
        class: 'analysis-run-at',
        text:
          at === 0
            ? `latest of ${runs.length} runs`
            : `run ${runs.length - at} of ${runs.length} · ${finishedAt(runs[at])}`,
        title: runDifference(runs[at], runs[0], task),
      }),
      newer,
      latest,
    )
  }

  /**
   * The overlay: every map's curves on one set of axes.
   *
   * Not a `TaskResult`, and therefore not routed through {@link syncOutputs}: it
   * has no single provenance, so it has no framing line, no *recompute*, and no
   * TSV — the per-map tabs are where a number with one origin is exported from.
   * What it has is the picture, and PNG and PDF of the picture.
   */
  private syncCombined(across: ReadonlyArray<{ target: RunTarget; result: TaskResult }>): void {
    this.drawn = null
    this.combined = true
    this.clearFigures()
    this.setStatus('')
    this.notesEl.classList.add('hidden')
    this.recordEl.classList.remove('hidden')
    this.recordNote.textContent = `${across.length} maps, overlaid`

    const { curves, perMapOnly } = combineResults(
      across.map((entry) => ({ label: entry.target.label, result: entry.result })),
      (output) =>
        output.kind === 'curve'
          ? output
          : output.kind === 'profile'
            ? profileCurve(output)
            : null,
    )

    const blocks: HTMLElement[] = curves.map((curve) => this.combinedBlock(curve))
    if (perMapOnly.length > 0) {
      blocks.push(
        el('p', {
          class: 'analysis-elsewhere',
          text:
            `${perMapOnly.join(', ')} ${perMapOnly.length === 1 ? 'is' : 'are'} one picture per ` +
            'map rather than one across them — a pileup averaged over four libraries would be a ' +
            'fifth thing nobody asked for. They are on the tabs above.',
        }),
      )
    }
    if (blocks.length === 0) {
      blocks.push(
        el('p', {
          class: 'analysis-elsewhere',
          text: 'Nothing this task produces can be drawn across maps. Its tabs are above.',
        }),
      )
    }
    this.outputsEl.replaceChildren(...blocks)
    this.paintWidth()
  }

  /**
   * One overlaid curve, with the two exports that mean anything for it.
   *
   * The same shell every other figure gets, keyed under the task's id with a
   * suffix: a curve drawn *across* the maps is a different picture from the
   * per-map one of the same name, and a reader who logs one has not said
   * anything about the other.
   */
  private combinedBlock(curve: CurveOutput): HTMLElement {
    const block = figureBlock({
      output: curve,
      task: `${this.current?.id ?? 'task'}:combined`,
      uri: this.options.context()?.uri ?? '',
      onPng: (figure) => void this.savePngPlain(figure, curve.label),
      onPdf: (figure) => void this.savePdfPlain(figure, curve.label),
    })
    this.figures.push(block)
    return block.el
  }

  // -------------------------------------------------------------------------
  // The framing
  // -------------------------------------------------------------------------

  /**
   * Which framing the numbers belong to, and whether the view has left it.
   *
   * With a result on screen this is the *result's* framing and not the view's,
   * which is the whole of §18.4 in one line of text: the picture is a record of
   * where the reader was looking when they asked, and it does not follow them
   * around. **Recompute here** is how they ask again, and it appears only when
   * there is something to recompute against.
   */
  private syncFraming(result: TaskResult | null): void {
    const current = this.options.framing()
    if (result !== null) {
      const provenance = result.provenance
      const stale = current !== null && !framingHolds(provenance, current)
      this.framingEl.className = stale ? 'analysis-framing is-stale' : 'analysis-framing'
      this.framingEl.textContent = stale
        ? `from ${provenance.framing.label} — the view has moved since`
        : `from ${provenance.framing.label}`
      this.framingEl.title = provenance.framing.label
      this.recomputeButton.classList.toggle('hidden', !stale)
      return
    }
    this.framingEl.className = 'analysis-framing'
    this.framingEl.textContent =
      current === null ? 'no contact map in this view' : `will run on ${current.label}`
    this.framingEl.title = current?.label ?? ''
    this.recomputeButton.classList.add('hidden')
  }

  // -------------------------------------------------------------------------
  // Outputs
  // -------------------------------------------------------------------------

  /**
   * Draw what the last run produced, when it is not already drawn.
   *
   * Compared by identity, which is enough: the runner stores a new object per
   * run and never mutates one, so a result that is the same object is a result
   * whose figures are already on screen. Rebuilding them anyway would throw away
   * a scroll position in a table and re-run every canvas layout at ten hertz
   * while the *next* job reports progress.
   */
  private syncOutputs(result: TaskResult | null): void {
    if (result === this.drawn && !this.combined) return
    this.combined = false
    this.drawn = result
    this.clearFigures()
    this.setStatus('')

    if (result === null) {
      this.outputsEl.replaceChildren()
      this.notesEl.replaceChildren()
      this.notesEl.classList.add('hidden')
      this.recordEl.classList.add('hidden')
      return
    }

    const provenance = result.provenance
    this.recordEl.classList.remove('hidden')
    // `computed in 16 ms at 20:49:46`. The ISO string with its milliseconds and
    // its Z is what `copy provenance` beside this line writes and what every
    // export carries at its head; on screen it is twenty-four characters of
    // which the reader wants six, and a reader who read one in a sentence
    // reasonably took it for machine output that had leaked. The exact stamp is
    // one hover away and is the same string the clipboard takes.
    this.recordNote.textContent = `computed in ${durationText(result.ms)} at ${finishedAt(result)}`
    this.recordNote.title = provenance.createdAt
    this.paintCli(provenance)

    // The things the reader must be told that are not errors — *412 of 5,000
    // windows dropped for missing data*. Above the pictures, because a note that
    // changes what a number means has to be read before the number is.
    this.notesEl.replaceChildren(
      ...result.notes.map((note) => el('li', { text: note })),
    )
    this.notesEl.classList.toggle('hidden', result.notes.length === 0)

    // A run that produced nothing says so. Every runner that returns no output
    // now also leaves a note saying which input was missing, so this is the
    // backstop rather than the explanation — but without it a task that finished
    // in a millisecond and drew nothing is indistinguishable from one that
    // crashed silently, which is exactly how this read before the notes existed.
    this.outputsEl.replaceChildren(
      ...(result.outputs.length === 0
        ? [
            el('p', {
              class: 'analysis-elsewhere',
              text:
                result.notes.length === 0
                  ? 'This run produced no output, and said nothing about why. That is a bug — please report it.'
                  : 'No output was produced. The reason is above.',
            }),
          ]
        : this.outputBlocks(result.outputs, provenance)),
    )
  }

  /**
   * The run's outputs, with the ones that went elsewhere gathered.
   *
   * A figure is its own block. The outputs that are *not* pictures share one
   * sentence about where they went, and that sentence is printed once for the
   * run rather than once per output — which is the whole of this method. Spatial
   * tracks makes three lanes, and three lanes used to mean three dashed boxes
   * each repeating the same thirty words, with a lone TSV under each: the reader
   * scanned three identical paragraphs to find three buttons, and the drawer
   * looked as though it had produced prose. Now it is one sentence and three
   * named rows.
   *
   * Consecutive and by destination, not a sort: a task that returns a lane, a
   * matrix and a second lane meant those two lanes to be read either side of the
   * picture, and the order a runner returns its outputs in is the order §18.7
   * says the drawer shows them in.
   */
  private outputBlocks(outputs: readonly TaskOutput[], provenance: Provenance): HTMLElement[] {
    const blocks: HTMLElement[] = []
    let run: { where: Elsewhere; items: TaskOutput[] } | null = null
    const flush = (): void => {
      if (run === null) return
      blocks.push(this.elsewhere(run.where, run.items, provenance))
      run = null
    }
    for (const output of outputs) {
      const where = this.elsewhereOf(output)
      if (where === null) {
        flush()
        blocks.push(this.block(output, provenance))
      } else if (run !== null && run.where === where) {
        run.items.push(output)
      } else {
        flush()
        run = { where, items: [output] }
      }
    }
    flush()
    return blocks
  }

  /**
   * Where an output went instead of being drawn here, or `null` for a figure.
   *
   * The two that are not pictures go elsewhere — while there *is* an elsewhere.
   * On a file with no Annotations panel a profile is drawn here like any other
   * figure (§8.5 gives it no card to be a row on), and an interval set still has
   * no picture to be drawn as, so it keeps a sentence and says the true thing
   * about where its coordinates are.
   */
  private elsewhereOf(output: TaskOutput): Elsewhere | null {
    if (output.kind === 'intervals') {
      if (output.entryKind === 'structure') return 'structure'
      return this.options.hasLanes() ? 'overlay' : 'loose'
    }
    return output.kind === 'profile' && this.options.hasLanes() ? 'lane' : null
  }

  private block(output: TaskOutput, provenance: Provenance): HTMLElement {
    // Everything here is a `FigureBlock`: the figure, the slim strip of controls
    // over it, and the button that opens the whole settings column beside it at
    // the size of the window (§18.13). What the reader sets there is what the
    // PNG and the PDF below draw, because both are handed the figure as it
    // stands rather than the output the task returned.
    const block = figureBlock({
      output,
      task: this.current?.id ?? 'task',
      uri: this.options.context()?.uri ?? '',
      extras: [
        // The two formats a genome browser opens, on the one file where this
        // drawer is the only place they are offered from (§18.7).
        ...(output.kind === 'profile' ? this.profileButtons(output, provenance) : []),
        this.tsvButton(output, provenance),
      ],
      onPng: (figure) => void this.savePng(figure, output, provenance),
      onPdf: (figure) => void this.savePdf(figure, output, provenance),
    })
    this.figures.push(block)
    return block.el
  }

  /** bigWig and bedGraph, written by the workspace because they need the assembly. */
  private profileButtons(output: ProfileOutput, provenance: Provenance): HTMLButtonElement[] {
    const write = (format: 'bigwig' | 'bedgraph'): void => {
      void this.options.writeProfile(output, provenance, format).catch((err: unknown) => {
        this.setStatus(err instanceof Error ? err.message : String(err))
      })
    }
    return [
      button('bigWig', () => write('bigwig'), {
        class: 'btn',
        title:
          'Written here, byte for byte — no bedGraphToBigWig step. What IGV, deepTools and ' +
          'pyBigWig open.',
      }),
      button('bedGraph', () => write('bedgraph'), {
        class: 'btn',
        title:
          'One line per bin that has a value; bins with none are omitted, never written as 0.',
      }),
    ]
  }

  /**
   * The outputs that are not pictures, and where they went instead.
   *
   * A profile is a lane and a called interval is an overlay (§18.5, §18.7), and
   * both are ordinary rows on the Annotations panel from the moment they arrive
   * — the same implementation a loaded bigWig or BED gets, not a second one. The
   * sentence is here so the drawer does not look as though the run produced
   * nothing, and the TSV is here because §18.7's *every output offers TSV* has
   * no exceptions.
   *
   * **The sentence is about the run and the rows are about the outputs**, which
   * is what stopped it being printed N times. It says where and the rows say
   * what: a name and its export buttons, one line each. What the sentence no
   * longer says is what a lane *is* — "one value per bin, so it is a lane rather
   * than a picture, with the colour, limits, edges and figure every other track
   * has" is teaching, and the reader can see the lane on the map. Nor does it
   * say what a bed3d is read by, which is on the bed3d button's own tooltip.
   *
   * It does have to know whether that panel exists. It used to say the same
   * thing on every file, which on a `.metacool` sent a reader to a card that is
   * not on screen — the one shape of wrongness a sentence about *where something
   * went* must never have. A profile does not reach here on such a file at all
   * (see {@link elsewhereOf}); an interval set does, because a set of
   * coordinates has no picture to be drawn as either way, and it says plainly
   * that the BED beside it is the way to get them.
   */
  private elsewhere(
    where: Elsewhere,
    outputs: readonly TaskOutput[],
    provenance: Provenance,
  ): HTMLElement {
    const many = outputs.length > 1
    const sentence =
      where === 'lane'
        ? many
          ? `${fmt.int(outputs.length)} tracks added to the Synthetic tracks card in the Annotations panel.`
          : 'Added to the Synthetic tracks card in the Annotations panel.'
        : where === 'structure'
          ? 'Added to the Structures card in the Annotations panel, and shown in the deck’s ' +
            'structure cell (add one from the deck’s bar if none is open).'
          : where === 'overlay'
            ? many
              ? `${fmt.int(outputs.length)} overlays added to the Annotations panel, drawn on the map they were called from.`
              : 'Added to the Annotations panel as an overlay, drawn on the map it was called from.'
            : 'This file carries no annotation layer, so there is no overlay to draw these on. ' +
              'Take them as a BED, which this app reads back on any file that has one.'
    return el(
      'div',
      { class: 'analysis-elsewhere' },
      el('span', { text: sentence }),
      ...outputs.map((output) =>
        el(
          'div',
          { class: 'plot-icon-row' },
          el('span', { class: 'analysis-elsewhere-name', text: output.label, title: output.label }),
          ...(output.kind === 'intervals' ? [this.bedButton(output, provenance)] : []),
          this.tsvButton(output, provenance),
        ),
      ),
    )
  }

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  /**
   * The called intervals as the file everything else reads.
   *
   * A boundary set is a list of coordinates, and a list of coordinates leaves
   * this app as BED or as BEDPE — bedtools reads it, IGV reads it, and this
   * app's own sniffer reads it back as an overlay, which is the property
   * `analysis-bed-export.test.ts` checks rather than the text. The TSV beside it
   * is the same rows with the provenance above them, for a reader rather than
   * for a tool.
   */
  private bedButton(output: IntervalsOutput, provenance: Provenance): HTMLButtonElement {
    const structure = output.entryKind === 'structure'
    const format = structure ? 'bed3d' : output.payload.kind === 'pairs' ? 'BEDPE' : 'BED'
    return button(format, () => this.saveIntervals(output, provenance), {
      class: 'btn',
      title: structure
        ? 'The model as a bed3d — chrom, start, end, x, y, z — which this app and g3dtools read back'
        : `The called intervals as a ${format} — what bedtools reads, and what this app reads back`,
    })
  }

  private saveIntervals(output: IntervalsOutput, provenance: Provenance): void {
    const stamp = fileStamp(new Date())
    const context = {
      label: output.label,
      file: provenance.framing.label,
      created: provenance.createdAt,
    }
    const payload = output.payload
    const structure = output.entryKind === 'structure' && payload.kind === 'features'
    const text =
      structure && payload.kind === 'features'
        ? writeBed3d(payload.data, context)
        : formatIntervals(payload, context)
    const suffix = structure ? 'bed3d' : payload.kind === 'pairs' ? 'bedpe' : 'bed'
    downloadBlob(
      new Blob([text], { type: 'text/plain' }),
      exportName(output, provenance, stamp, suffix),
    )
  }

  /**
   * The output as a table of numbers, with the provenance above them.
   *
   * **Bordered**, like every other way data leaves this app (§26.6). It was a
   * `btn-quiet` — grey text with no border — in a strip that also held a
   * bordered icon button, so the one control that gets the numbers out read as a
   * caption naming the table's format.
   */
  private tsvButton(output: TaskOutput, provenance: Provenance): HTMLButtonElement {
    return button('TSV', () => this.saveTsv(output, provenance), {
      class: 'btn',
      title:
        'The numbers as a table, with the provenance above them — what makes a figure ' +
        'checkable by the person reading it.',
    })
  }

  private saveTsv(output: TaskOutput, provenance: Provenance): void {
    const stamp = fileStamp(new Date())
    const blob = new Blob([outputToTsv(output, provenance)], {
      type: 'text/tab-separated-values',
    })
    downloadBlob(blob, tsvName(provenance.task, output, stamp))
  }

  /**
   * The figure as a PNG, redrawn rather than screen-grabbed.
   *
   * The box is the one the figure occupies on screen, because that is the layout
   * the reader chose: widening the drawer is how a curve is given room, and an
   * export at some other width would be a different figure. Only the density
   * changes.
   */
  /**
   * PNG and PDF for a figure that is not one run's output.
   *
   * The combined overlay has no single provenance — that is what makes it a
   * comparison rather than a result — so it cannot use {@link exportName}, which
   * builds a filename out of a task and a framing. It gets the figure's own
   * label and the timestamp, which is what a reader assembling a figure needs
   * from a filename anyway.
   */
  private async savePngPlain(figure: PlotFigure, label: string): Promise<void> {
    try {
      const box = figureBox(figure.el)
      const scale = scaleForDpi(FIGURE_EXPORT_DPI)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(box.width * scale))
      canvas.height = Math.max(1, Math.round(box.height * scale))
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('The browser would not give this page a canvas.')
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      figure.draw(ctx, box)
      downloadBlob(await canvasToPng(canvas), `${plainName(label)}-${fileStamp(new Date())}.png`)
      this.setStatus('')
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  private async savePdfPlain(figure: PlotFigure, label: string): Promise<void> {
    try {
      const box = figureBox(figure.el)
      const now = new Date()
      const page = new VectorPage(box.width, box.height)
      figure.draw(page.ctx, box)
      const blob = await page.toBlob({ title: label, created: now })
      downloadBlob(blob, `${plainName(label)}-${fileStamp(now)}.pdf`)
      this.setStatus('')
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  private async savePng(
    figure: PlotFigure,
    output: TaskOutput,
    provenance: Provenance,
  ): Promise<void> {
    try {
      const box = figureBox(figure.el)
      const scale = scaleForDpi(FIGURE_EXPORT_DPI)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(box.width * scale))
      canvas.height = Math.max(1, Math.round(box.height * scale))
      const ctx = canvas.getContext('2d')
      if (ctx === null) throw new Error('The browser would not give this page a canvas.')
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      figure.draw(ctx, box)
      downloadBlob(await canvasToPng(canvas), exportName(output, provenance, fileStamp(new Date()), 'png'))
      this.setStatus('')
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * The same figure as a one-page PDF, written as *drawing* rather than as a
   * photograph of one.
   *
   * This is the whole return on `analysisPlots.ts` drawing through a context and
   * nothing else: `VectorPage` implements that context and emits PDF operators,
   * so the export has nothing of its own to reimplement and cannot drift from
   * what was on screen.
   */
  private async savePdf(
    figure: PlotFigure,
    output: TaskOutput,
    provenance: Provenance,
  ): Promise<void> {
    try {
      const box = figureBox(figure.el)
      const now = new Date()
      const page = new VectorPage(box.width, box.height)
      figure.draw(page.ctx, box)
      const blob = await page.toBlob({ title: output.label, created: now })
      downloadBlob(blob, exportName(output, provenance, fileStamp(now), 'pdf'))
      this.setStatus('')
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Whether the shell can be offered this run, and what the button then says.
   *
   * **Disabled with a reason, rather than absent.** A row of one button says
   * nothing about the second while a greyed one with a sentence in its tooltip
   * says exactly when it applies — the argument `ui/SyntheticCard.ts` makes
   * about its own bigWig button, and the same alternative to avoid: a button
   * wired to something that writes a command line the command then rejects,
   * which the reader finds out somewhere else, later, with the app closed.
   */
  private paintCli(provenance: Provenance): void {
    // A task this build has never heard of — a result restored from a session
    // written by a later one — is the one run with no command: the flags are
    // the descriptor's, and there is no descriptor, so the button goes quiet
    // rather than guessing at them. Every task this build has is one
    // `metacooler-run` takes (`analysis/cliCommand.ts`).
    const unknown = taskById(provenance.task) === undefined
    this.cliButton.disabled = unknown
    this.cliButton.title = unknown
      ? `This build does not have the task ${provenance.task}, so it cannot write its flags.`
      : 'The same run as a metacooler-run command line — the file, the window, the balancing ' +
        'and every parameter — for the other two hundred files.'
  }

  /**
   * Put the command on the clipboard, and say what it left behind.
   *
   * The status line names the notes rather than repeating them: they are on the
   * clipboard as `#` lines above the command, where a reader pasting into a
   * script will actually meet them, and a drawer that printed them twice would
   * be the second place they can go stale.
   */
  private copyCliCommand(): void {
    const result = this.drawn
    if (result === null) return
    const task = taskById(result.provenance.task)
    if (task === undefined) return
    const command = cliCommandFor({
      task,
      provenance: result.provenance,
      context: this.options.context(),
    })
    const caveats = command.text.split('\n').filter((line) => line.startsWith('#')).length
    void copyTextToClipboard(command.text).then(
      () => {
        this.setStatus(
          caveats === 0
            ? 'CLI command copied.'
            : `CLI command copied, with ${caveats} note${caveats === 1 ? '' : 's'} on what a ` +
              'shell cannot be told.',
        )
      },
      (err: unknown) => {
        this.setStatus(err instanceof Error ? err.message : String(err))
      },
    )
  }

  /**
   * The provenance on the clipboard, in the same `#` lines every export carries.
   *
   * Read off the *shown* result rather than rebuilt from the form: the point of
   * it is to describe the numbers on screen, and a reader who has since changed
   * a parameter would otherwise copy a recipe that produced something else.
   */
  private copyProvenance(): void {
    const result = this.drawn
    if (result === null) return
    const text = provenanceLines(result.provenance).join('\n')
    void copyTextToClipboard(text).then(
      () => {
        this.setStatus('Provenance copied.')
      },
      (err: unknown) => {
        this.setStatus(err instanceof Error ? err.message : String(err))
      },
    )
  }
}
