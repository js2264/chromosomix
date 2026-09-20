/**
 * What an analysis *is*, before anything decides how to run it or draw it.
 *
 * Everything in this module is free of DOM, canvas and worker concerns, for the
 * same reason `annotations/types.ts` is: these descriptions cross the worker
 * boundary, get persisted, drive the form renderer and drive the drawer. Spec
 * §18.
 *
 * The distinction this whole subtree rests on is in §18's opening paragraph.
 * Everything else the app does is a **reading of a file** — it happens between
 * two paints, it is discarded when the view moves, and if it is slow the app is
 * broken. An analysis is a **job**: it outlives the view that started it, it can
 * fail halfway, and the only honest response to a slow one is a progress bar and
 * a cancel. A job therefore needs four things a frame does not: a place to be
 * configured ({@link ParamSpec}), a record of exactly what it ran on
 * ({@link Provenance}), a statement of what it will cost before it starts
 * ({@link CostEstimate}), and outputs that can leave the page as files
 * ({@link TaskOutput}).
 *
 * **A task is a descriptor, never a screen.** One generic renderer turns
 * {@link AnalysisTask.params} into controls, so adding a task is adding data.
 * The precedent is `ui/plotOptions.ts`, where one table drives the labels, the
 * marks, the tooltips and the commands — and the copy that goes stale is the one
 * that does not exist.
 */

import type { GroupMode } from '../annotations/groups'
import type {
  AnnotationEntry,
  AnnotationKind,
  AnnotationPayload,
  TrackMode,
  TrackScale,
} from '../annotations/types'
import type { Extent, LayoutKind } from '../types'

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * What one parameter can be worth.
 *
 * Deliberately narrow, and every member is structured-cloneable and
 * JSON-round-trippable: a parameter set is posted to a worker, written into
 * `UiMemory`, carried in an exported session and printed at the top of a TSV.
 * A value that survives only three of those four is a value that goes missing
 * in the fourth.
 */
export type ParamValue = number | string | boolean | readonly string[] | null

/** One task's settings, keyed by {@link ParamSpec.key}. */
export type Params = Readonly<Record<string, ParamValue>>

/**
 * A length the user types, and the unit they typed it in.
 *
 * Offered in base pairs by default, with the resolved bin count shown beneath
 * the box, because bins are a property of the file and base pairs are a property
 * of the question (§18.2). `''` is the unitless case — a count of components, a
 * number of quantiles — and `%` is drawn with its sign.
 */
export type ParamUnit = '' | 'bp' | 'bins' | '%' | 'x'

interface ParamBase {
  /** Stable. Used in `Params`, in storage and in provenance; never a label. */
  key: string
  label: string
  /** One line under the control. */
  hint?: string
  /**
   * Whether this control is shown at all, given the rest of the form.
   *
   * The distance-matched controls belong to one normalisation and are noise
   * under the other two; a form that shows every field a task has ever had is a
   * form nobody reads. Pure, and re-evaluated on every change.
   */
  when?(params: Params): boolean
  /**
   * Offered only where the file has **no** `/genomes` table.
   *
   * The mirror of {@link ChoiceOption.needsGenomes}, and it bends §18.2's *a task
   * is a descriptor, never a screen* by the same stated rule: the descriptor
   * still lists the control and says which files it is a question for, and what
   * varies is whether this one can answer it.
   *
   * The case is 4C on a metagenome. *Cis only* and *Normalisation* are real
   * questions on a cooler — a chromosome is a self-contained thing and its own
   * P(s) is the curve to divide by — and on a metacool neither is: an anchor
   * there is a MAG among hundreds of others in the same tube, the reading that is
   * wanted is what it touches **everywhere**, and a decay curve taken from one
   * assembly's contigs is not an expectation for contact between assemblies. The
   * runner settles both keys itself on such a file (`run/fourc.ts`), so what this
   * flag removes is a control whose answer was never the reader's to give.
   */
  needsNoGenomes?: boolean
  /**
   * What this parameter is worth on a file that is not asked about it.
   *
   * A hidden control still has a value, and that value is written into the
   * provenance of every run and into the header of every TSV exported from one.
   * Left at its default it says something false: a 4C run on a metagenome, which
   * reads the whole file, exported a table headed `param cis: true`. The number
   * a reader compares against would then be attributed to a computation nobody
   * performed, which is the one thing a provenance block exists to prevent.
   *
   * So the form settles it to the file's answer when it drops the control. The
   * *runner* settles it again for itself, because a job can reach the worker
   * without passing through a form; this one is about what the run is recorded
   * as, not about what it does.
   */
  settled?: ParamValue
  /**
   * Group heading this control sits under, for tasks with more than a handful.
   *
   * Absent means the top group, which is where the parameters somebody actually
   * changes should be. A task whose *first* control is behind a heading has its
   * headings wrong.
   */
  section?: string
}

export interface NumberParam extends ParamBase {
  kind: 'number'
  default: number
  min?: number
  max?: number
  step?: number
  unit?: ParamUnit
  /** Draw a slider beside the box. For a bounded range somebody sweeps. */
  slider?: boolean
  /** Whole numbers only — a window in bins, a component count. */
  integer?: boolean
}

/**
 * One entry in a pick-one list.
 *
 * `label` is what a metagenome calls it and `coolLabel` is what a plain cooler
 * does, where the two differ — "contig" against "chromosome", "whole file"
 * against "whole genome". The words are not interchangeable to a reader: a MAG
 * *is* a genome and a chromosome is not, so a cooler offering "Genome" beside
 * "Contig" invites the reading that the first means the whole file, which is
 * what the third option already means.
 *
 * `needsGenomes` drops an option from a file that has no `/genomes` table. This
 * is the one place §18.2's *a task is a descriptor, never a screen* bends, and
 * it bends by a stated rule rather than by building the descriptor per file: the
 * option is still static data, and what varies is whether this file can answer
 * it. The alternative — always offering it and refusing the run — was what
 * shipped, and asking a reader to press Run to discover that a choice was never
 * available is worse than not offering it. A *stored* session naming a dropped
 * option still resolves, because the runner reads the parameter and falls back;
 * only the control stops offering it.
 */
export interface ChoiceOption {
  value: string
  label: string
  /** What to call it on a file with no genomes. Defaults to {@link label}. */
  coolLabel?: string
  hint?: string
  /** Offered only where the file has a `/genomes` table. */
  needsGenomes?: boolean
  /**
   * Offered only where one of these annotation kinds is loaded.
   *
   * APA is the case. It is offered on any file that has *something* to aggregate
   * over, and then its Anchors control asks whether that something is a loop set
   * or a feature set — a question with a wrong answer available: with only ATAC
   * peaks open, "Loop set" is a mode whose own input cannot be filled, so the
   * task defaulted to it and refused itself. Naming the kinds an option needs is
   * how the descriptor says which halves of itself this file can run, and
   * `resolveChoiceDefaults` moves the value onto one that is offered.
   */
  needsKinds?: ReadonlyArray<AnnotationKind>
}

export interface ChoiceParam extends ParamBase {
  kind: 'choice'
  default: string
  options: ReadonlyArray<ChoiceOption>
}

export interface ToggleParam extends ParamBase {
  kind: 'toggle'
  default: boolean
  /**
   * Answered from the **file** rather than asked of the reader, and not shown.
   *
   * Balancing is the case this exists for, and it is worth stating why it is not
   * simply a default. "Use balancing weights" is a question with one right
   * answer per file — a balanced cooler should be read balanced, and a raw one
   * has no weights to apply — so a tickbox there is not a choice, it is a way to
   * get a wrong picture. Worse, it was a wrong picture that looks fine: an
   * unbalanced P(s) or insulation curve is a perfectly plausible shape, and
   * nothing in the figure says which one you asked for.
   *
   * So the descriptor states the rule, the form evaluates it against the context
   * and writes the value, and the control is never built. The parameter is still
   * a parameter in every other sense — the runners read it exactly as before,
   * and it is in the provenance, so a TSV still says whether the numbers were
   * balanced.
   *
   * Pure, and re-evaluated whenever the context changes: opening the same file
   * at a resolution that carries weights turns it on by itself.
   */
  derive?(context: AnalysisContext): boolean
}

/** Whether this control is answered from the file rather than by the reader. */
export function paramDerived(spec: ParamSpec): boolean {
  return spec.kind === 'toggle' && spec.derive !== undefined
}

/**
 * A parameter that names something already loaded.
 *
 * Four of them, and all four **default to the starred entry** where the concept
 * exists — the same star the 1D browser's feature search is keyed on
 * (`AnnotationEntry.primary`, §5.8). This is what lets compartment phasing be a
 * dropdown rather than a second file drop.
 */
export interface EntryParam extends ParamBase {
  kind: 'featureSet' | 'pairSet' | 'track' | 'sequence'
  /** Several may be chosen; the value is then a `string[]` of entry ids. */
  multiple?: boolean
  /** The empty choice is offered, and the value may be `null`. */
  optional?: boolean
  /** Label for the empty choice. Only read when `optional`. */
  noneLabel?: string
}

/**
 * A numeric column of whichever feature set another parameter chose.
 *
 * `from` names that parameter's key rather than a set, because the column list
 * has to follow the dropdown above it: picking a different peak file and being
 * left with the previous file's column names is the bug this avoids.
 */
export interface ColumnParam extends ParamBase {
  kind: 'column'
  from: string
  optional?: boolean
  noneLabel?: string
}

/**
 * Free text — an answer that is neither a number, nor a choice, nor a file.
 *
 * The last kind to be added, and it was resisted for as long as it could be: a
 * box the reader can type anything into is a control the descriptor cannot check
 * and the form cannot help with, so every parameter that could be a list was
 * made a list instead. What finally needed one is a **motif** (§8.3): `GATC`,
 * `GGTCANNNTGACC`, `TTAGGG` — a string in an alphabet the task validates, out of
 * a space no dropdown could enumerate and no number could stand in for.
 *
 * Deliberately *not* {@link RegionParam} with the sequence list turned off, which
 * is the shape it would otherwise have borrowed. That control offers the file's
 * contig names in a `<datalist>`, seeds itself from the framing, and says in its
 * tooltip that it takes a locus — three helpful behaviours that are three lies
 * about a motif, and a reader typing `GATC` into a box that had just suggested
 * `chrIV` would be right to wonder which of the two the task was reading.
 *
 * The value is a plain string and nothing more: the *task* decides what a
 * well-formed one is, and says so through its {@link AnalysisTask.estimate}
 * refusal, which is where a form-time complaint about a parameter belongs.
 */
export interface TextParam extends ParamBase {
  kind: 'text'
  /** Absent means the box starts empty, which is a state the estimate may refuse. */
  default?: string
  /** Shown in the empty box. An example, never a restatement of the label. */
  placeholder?: string
}

/** A locus, in the syntax the views' own boxes take. Defaults to the framing. */
export interface RegionParam extends ParamBase {
  kind: 'region'
  default?: string
  /**
   * This names a **whole sequence**, so offer the file's list rather than a box.
   *
   * Insulation, CID and compartments all take a sequence and use the whole of it
   * — a score taken from whatever happened to be on screen but labelled `chrIV`
   * is a different quantity wearing the same name — so a free-text box here
   * accepted spans it would silently ignore, and asked a reader to type a
   * chromosome name the app already knows. A `<select>` cannot be wrong.
   *
   * Left off where a *locus* is meant: a 4C anchor is a window, and narrowing it
   * to a whole sequence would remove the task's whole point. Those keep the box,
   * with the sequence names offered as a `<datalist>` so the common case is
   * still a pick rather than a spelling test.
   */
  sequences?: boolean
  /**
   * The box takes **several sequences**, comma-separated, and is seeded from
   * what the map shows (§25.6): every sequence on screen when the view spans
   * more than one, the locus when it is inside one, and **empty for the whole
   * file**, since empty means every sequence and a list of all of them is the
   * same answer said the long way. The structure tasks take it; a task that
   * reads one sequence leaves it off and gets the first on screen.
   */
  many?: boolean
  /**
   * Empty is not an answer, so the list says *choose one* rather than *every*.
   *
   * Compartments is the case: a correlation matrix is a property of one
   * chromosome, and there is no whole-file reading to fall back on. Insulation
   * and CID leave this off, where empty legitimately means every sequence.
   */
  required?: boolean
  /**
   * Offer a **Pick on map** button beside the box.
   *
   * Shift-drag on the map names a stretch of one axis; ordinarily that zooms,
   * and while the button is lit it fills this box instead — once, and then the
   * button goes out (`ui/mapPick.ts`). What the reader is doing is answering a
   * question the form asked, so the form is where the asking is visible.
   *
   * Not recorded as a parameter of its own, and that is a deliberate change from
   * the toggle this replaces: what belongs in the provenance is the *locus*, and
   * "typed" versus "pointed at" is a fact about the reader's hand rather than
   * about the number. The value written is always the resolved locus.
   *
   * Ignored where there is no map to point at — the panel exists on a
   * tracks-only session (§18.2), and a button nothing can answer is worse than
   * no button.
   */
  pickable?: boolean
}

/**
 * **Several** whole sequences, ticked.
 *
 * The plural of {@link RegionParam}'s `sequences` mode, and a different question
 * rather than a wider one. A task takes this where its answer is over a *set* of
 * sequences at once and not one reading per sequence: compartments is the case —
 * a correlation over four chromosomes' cis and trans blocks together is a
 * genome-wide eigenvector, which is not any of the four per-chromosome ones and
 * cannot be assembled from them.
 *
 * The value is the names, explicitly, and **never a sentinel**. `[]` means
 * nothing is ticked — a state the form can be in and the estimate refuses — and
 * every-one-ticked is every name, written out. That is the opposite convention
 * to `genome/selection.ts`, where empty means the whole genome, and deliberately:
 * there the empty set is the *default* and the reader never has to reach it,
 * while here it is a thing a reader can do by pressing **None**, and a run whose
 * parameters read `[]` should not be indistinguishable from one that ran over
 * everything.
 *
 * Never answered at all is `null`, which the form resolves to every sequence the
 * file has — so a task with one of these starts genome-wide.
 */
export interface SequencesParam extends ParamBase {
  kind: 'sequences'
}

/**
 * The seed of a task that samples.
 *
 * Present on every one of them, and not as a nicety: a figure has to come out
 * the same twice (§18.4). Tasks use `analysis/random.ts` rather than
 * `Math.random()`, and the seed is part of the provenance.
 */
export interface SeedParam extends ParamBase {
  kind: 'seed'
  default: number
}

export type ParamSpec =
  | NumberParam
  | ChoiceParam
  | ToggleParam
  | EntryParam
  | ColumnParam
  | RegionParam
  | TextParam
  | SequencesParam
  | SeedParam

/** The defaults a task starts with, before memory or a session overrides them. */
export function defaultParams(specs: readonly ParamSpec[]): Params {
  const out: Record<string, ParamValue> = {}
  for (const spec of specs) {
    switch (spec.kind) {
      case 'number':
      case 'seed':
        out[spec.key] = spec.default
        break
      case 'choice':
        out[spec.key] = spec.default
        break
      case 'toggle':
        out[spec.key] = spec.default
        break
      case 'region':
      // `''` and not `null`, like a region: an empty box is a box nobody has
      // typed in, and the one thing it must not become is the string `"null"`
      // in the header of an exported table.
      case 'text':
        out[spec.key] = spec.default ?? ''
        break
      // `null` rather than `[]`, and the difference is the whole convention:
      // the form resolves *unanswered* to every sequence the file has, and `[]`
      // is a reader who pressed **None**. See {@link SequencesParam}.
      case 'sequences':
        out[spec.key] = null
        break
      // An entry parameter's default is whatever is loaded *now*, which this
      // function cannot know — the form resolves it against the context on the
      // way in. `null` rather than `''` so "nothing chosen yet" is one value.
      case 'featureSet':
      case 'pairSet':
      case 'track':
      case 'sequence':
        out[spec.key] = spec.multiple === true ? [] : null
        break
      case 'column':
        out[spec.key] = null
        break
    }
  }
  return out
}

/**
 * Whether `spec` is shown, given the rest of the form and the file.
 *
 * Two rules and they are different in kind: `when` is about the other answers on
 * this form and is re-read on every keystroke, while `needsNoGenomes` is about
 * the file and changes only when the drawer is handed another one. Both end in
 * the same place — a wrapper out of the document, with its control and its state
 * kept — so a form does not have to know which of the two hid a row.
 */
export function paramVisible(
  spec: ParamSpec,
  params: Params,
  context: AnalysisContext,
): boolean {
  if (spec.needsNoGenomes === true && context.hasGenomes) return false
  return spec.when === undefined || spec.when(params)
}

// ---------------------------------------------------------------------------
// The framing: what a task ran on
// ---------------------------------------------------------------------------

/**
 * The map's framing at the instant **Run** was pressed.
 *
 * A **snapshot**, and that is the whole point (§18.4). A finished result is a
 * record rather than a live view: panning afterwards does not change a pileup,
 * the drawer states which framing the numbers belong to, and a **Recompute
 * here** button takes a new snapshot. It is the discipline the on-the-fly 4C
 * *lane* never kept — it redrew itself from whatever block was loaded, which is
 * one of the reasons it is gone (§18.9) and the 4C **task** is not a bigger
 * version of it.
 */
export interface AnalysisFraming {
  /** The file, so a result can never be shown against a different one. */
  uri: string
  /** Row and column bin ranges of what was on screen, in absolute bins. */
  rows: Extent
  cols: Extent
  /** The file's own bin size, in base pairs. */
  binsize: number
  /**
   * Bins summed per cell in the block that was on screen, or 1.
   *
   * Recorded rather than applied: a task that reads for itself reads at the
   * file's native resolution and ignores this, and a task that borrows the
   * view's block must not pretend the block is finer than it is.
   */
  binsPerCell: number
  balance: boolean
  /**
   * The `/pixels` column the view was drawn from.
   *
   * A **column**, never the score picker's id. The two look alike and are not:
   * `balanced` and `ICE` are entries in that picker and are not columns in any
   * file, so passing an id through here asks the reader for `/pixels/balanced`
   * and gets "does not exist" — which is what happened, on every task, on every
   * balanced cooler. `ui/scores.ts` is the one place that unflattens a choice
   * into this field and {@link balance} beside it.
   */
  value: string
  /**
   * A normalisation the *view* applies to the block after reading it, or `null`.
   *
   * VC, VC √ and ICE are computed by `render/derive.ts` on the main thread from
   * whatever was read; nothing in the file carries them and no read can ask for
   * one. So a task cannot reproduce the picture the reader is looking at, and
   * this field exists to say so rather than to be applied — the runner notes it
   * and reports the numbers it did compute, which are the underlying counts.
   */
  normalise: string | null
  level: 'bin' | 'contig' | 'genome'
  /** `chrIV:1–1,531,933 at 1 kb, balanced, count` — for the drawer's header. */
  label: string
  /**
   * The sequences the reader has declared **circular** (§8.15), by this file's
   * own names. Absent — not empty — where none is.
   *
   * A fact about the assembly rather than about the window, and it is in the
   * framing for the one reason the framing exists: it changes every number a cis
   * task produces, so it has to be in the provenance of the result. A plasmid
   * scored as a line has two artificial ends — every window overlapping them is
   * dropped, the decay curve turns up at the far end where the two ends of the
   * sequence are in fact adjacent, and nothing in the figure says so. Scored as a
   * circle it has none of that, and a reader comparing two exported tracks needs
   * to be able to tell which of the two they are holding.
   *
   * Names rather than ids, because a result outlives the mount it was computed on
   * and an id is meaningless against a different file. Optional so that every
   * existing construction site is unchanged and a session written by an older
   * build restores as what it was: nothing circular.
   */
  circular?: readonly string[]
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Everything needed to say where a number came from.
 *
 * Shown in the drawer, copied by one button, and written as `#` comment lines
 * into every export whose format has them — the same shape
 * `annotations/export.ts` already writes above a BED of hand-drawn marks. A
 * bigWig carries none, because BBI has nowhere to put one; see §18.4 on why
 * misusing `autoSql` for it is refused rather than clever.
 */
export interface Provenance {
  task: string
  taskVersion: number
  params: Params
  framing: AnalysisFraming
  /** App version and commit, from `src/version.ts`. */
  app: string
  /** ISO 8601, in local time, like every other stamp this app writes. */
  createdAt: string
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/**
 * One value per bin — which is to say, a track.
 *
 * It does not stay in the drawer. A per-bin result is exactly the object the
 * virtual 4C profile already proved the shape of (§8.9), so it becomes an
 * ordinary lane on the Annotations panel's synthetic card and inherits colour,
 * rename, limits, autoscale, four edges, reorder, groups, the tooltip, the 1D
 * browser and the vector figure — because it is the same implementation and not
 * a second one (§18.5).
 *
 * `values` is over `extent` and nothing else: `values[i]` is the bin
 * `extent[0] + i`. `NaN` means *no value here* and is written as a gap
 * everywhere downstream, never as zero — the distinction between "this bin was
 * filtered" and "this bin touches nothing" is the whole reason `bandSums` skips
 * rather than propagates.
 */
export interface ProfileOutput {
  kind: 'profile'
  id: string
  label: string
  values: Float32Array
  /** Absolute bin range `values` covers, half-open. */
  extent: Extent
  /** Base pairs per element of `values`. */
  binsize: number
  /** Printed after the numbers on the value axis; `''` for a bare count. */
  unit: string
  /** Suggested lane colour. The reader may change it, and then it is theirs. */
  colour?: string
  /**
   * The group this profile joins, where a task emits a *set* that is one
   * reading rather than several.
   *
   * Insulation at four windows is the case: they are the same measurement at
   * four smoothings, and four ungrouped lanes with four autoscaled axes is four
   * pictures a reader has to reconcile by eye. Named by the task, and from then
   * on an ordinary group — the reader can rename it, break it up, or set it to
   * scale each member separately, exactly as they can one they made themselves.
   */
  group?: string
  /**
   * How the lane draws, where the task has a better answer than the default.
   *
   * `heatmap` for the multi-scale insulation set, because that is the picture
   * (§18.11): a value per bin per window is a matrix, and crossing lines is what
   * a matrix looks like when it is drawn as one line per row.
   */
  mode?: TrackMode
  /**
   * How {@link group} shares the picture, where the task has an opinion.
   *
   * A suggestion for a group *nobody has decided about yet*: the workspace does
   * not overwrite a mode the reader set, so a set re-run after being pulled
   * apart comes back the way they left it.
   */
  groupMode?: GroupMode
  /**
   * The value axis the lane should open on, where the quantity has one.
   *
   * Absent means linear, which is right for every track that is a count, a
   * ratio against a mean, or a signed statistic. It is here for the scalogram,
   * whose values are **genomic separations**: those run from one bin to a whole
   * chromosome, so on a linear axis the four bands a reader is comparing are all
   * squashed into the bottom tenth of the lane and the picture is entirely
   * carried by whichever bin reached furthest.
   *
   * A display scale and nothing else, exactly as `AnnotationStyle.scale` is: the
   * numbers behind the lane and every number that leaves it as a file stay as
   * they were computed. And a *suggestion* — from the moment the row exists the
   * axis is the reader's, and changing it back is one control.
   */
  scale?: TrackScale
}

/** One line of a {@link CurveOutput}, with an optional band around it. */
export interface CurveSeries {
  name: string
  x: Float64Array
  y: Float64Array
  /**
   * The band, where there is one.
   *
   * A bootstrap interval for a metaplot, and nothing at all for a P(s) — so it
   * is optional rather than filled with copies of `y`, which is the mistake
   * `PixelProfile.envelope` exists to flag for the lane renderer.
   */
  low?: Float64Array
  high?: Float64Array
  colour?: string
  /** Feature or observation count behind this line, for the legend. */
  n?: number
  /**
   * How the series is drawn; a line unless it says otherwise.
   *
   * `points` is for a series whose x is not an ordering. Every other curve in
   * the catalogue is a function of a separation, a position or a rank, so
   * joining consecutive samples says something true about what is between them.
   * A cell-cycle scatter is not: its two axes are two fractions measured on the
   * same cell, the cells have no order along x, and a line through them would
   * draw a path nothing travelled.
   */
  mark?: 'line' | 'points'
}

export interface CurveOutput {
  kind: 'curve'
  id: string
  label: string
  series: CurveSeries[]
  xLabel: string
  yLabel: string
  xScale: 'linear' | 'log'
  yScale: 'linear' | 'log'
  /**
   * The window the axes should show, in data units; absent to fit the data.
   *
   * A *runner* sets these to say what the figure is worth opening on, which is
   * not always its full extent: a P(s) runs from one base pair to a whole
   * chromosome and the decade at each end is a spike and a handful of noisy
   * points, so a curve drawn over all of it spends its height on the parts
   * nobody reads. `figures/style.ts` then treats them as the *initial*
   * view — the marquee, the boxes and the reset all move them — so this is a
   * default rather than a limit, and it is on the output rather than in the
   * panel because which window is worth opening on is a fact about the
   * quantity.
   *
   * Either may be given alone. An absent axis is fitted to whatever falls inside
   * the one that was given, so a window in x carries the ordinate with it.
   */
  xDomain?: [number, number]
  yDomain?: [number, number]
}

/**
 * A small dense array: a pileup, a saddle, a correlation heatmap.
 *
 * Small on purpose. This is never a contact map — those are read by the reader
 * worker and drawn by `render/heatmap.ts` at scale — it is the output of an
 * aggregation, which is tens to a few hundred cells on a side. Drawn through the
 * same rasteriser and the same colormaps, so a pileup in the drawer and the map
 * behind it agree about what a colour means.
 */
export interface MatrixOutput {
  kind: 'matrix'
  id: string
  label: string
  nrows: number
  ncols: number
  /** Row-major, `nrows * ncols` long. `NaN` is drawn transparent. */
  values: Float32Array
  xLabel: string
  yLabel: string
  /** Tick labels along each axis, evenly spaced; empty for none. */
  xTicks: string[]
  yTicks: string[]
  /** Colormap name from `render/colormaps.ts`. */
  colormap: string
  /**
   * The value a diverging colormap is centred on, if it is one.
   *
   * `1` for a ratio, `0` for a correlation, absent for a raw pileup. A diverging
   * scale centred on the data's own midpoint would move the white point with the
   * data, which is the one thing a diverging scale must not do.
   */
  centre?: number
  /**
   * A colour scale the *task* fixes, rather than one fitted to the data.
   *
   * Absent almost everywhere, because a scale fitted to the picture is what
   * makes a picture readable. It is here for the one thing a fitted scale cannot
   * do: reproduce somebody else's figure. chromosight's pileup is drawn at
   * `vmin=0, vmax=2` on `seismic` whatever the numbers turn out to be, so two
   * pileups from two files are the same picture where they are the same result —
   * and a viewer that autoscaled would show a flat pileup and a strong one in
   * identical colours and call it the same plot.
   *
   * Takes precedence over {@link centre}, which is the *derived* version of the
   * same idea. `[lo, hi]`, and cells outside it clamp to the end colours, which
   * is matplotlib's `set_under`/`set_over` default and `colormapIndex`'s.
   */
  range?: [number, number]
  /** Numbers printed under the picture: P2LL, AA/BB strength, an r. */
  stats?: Array<{ label: string; value: number; digits?: number; hint?: string }>
}

/** A column of a {@link TableOutput}. */
export interface TableColumn {
  key: string
  label: string
  kind: 'text' | 'number'
  /** Decimal places for a number column; integers when absent. */
  digits?: number
  hint?: string
}

export interface TableOutput {
  kind: 'table'
  id: string
  label: string
  columns: TableColumn[]
  rows: Array<Record<string, string | number>>
}

/**
 * Intervals a task called: boundaries, domains, flagged contigs, loops.
 *
 * The payload is exactly what a parsed file would have produced, so it is
 * offered as a new row on the Annotations panel and becomes an overlay on the
 * map immediately — a called boundary the reader cannot see on the picture it
 * was called from is a called boundary nobody will check.
 */
export interface IntervalsOutput {
  kind: 'intervals'
  id: string
  label: string
  payload: AnnotationPayload
  /**
   * What the row *is*, where it is not a called interval set.
   *
   * A reconstructed model (§25.6) is a `FeatureSet` with a `model` on it —
   * exactly what a bed3d parses to — and it lands through the same door as a
   * called boundary set, but on the Structures card as a `structure` row that
   * the deck's cell draws, never as an overlay on the map. Absent is the
   * ordinary case: an overlay of segments or pairs.
   */
  entryKind?: 'structure'
  /**
   * What one of these *is*, so the row can say how many there are.
   *
   * A called set is a number of things, and the number is the first thing a
   * reader wants from it — a run that found 3 loops and a run that found 3,000
   * are different results, and until this the row said neither. A dropped BEDPE
   * has carried `1,204 pairs` under its name since there were rows at all
   * (`annotations/worker`); a computed one had nothing, which made the two kinds
   * of row unlike each other for no reason except that nobody had written it.
   *
   * The **task's own word**, not the payload's. Both halves of a loop set are
   * `pairs` to the parser and `loops` to the person who ran the detector, and a
   * row headed *Detected loops* that says `1,204 pairs` underneath is answering
   * a question about the file format. Absent falls back to the payload's word,
   * which is right for a task that has not been given one and is what every
   * loaded row already says.
   *
   * Both numbers, because English: `1 boundary`, `412 boundaries`, and no
   * `boundarys` anywhere.
   */
  noun?: { one: string; many: string }
}

export type TaskOutput =
  | ProfileOutput
  | CurveOutput
  | MatrixOutput
  | TableOutput
  | IntervalsOutput

/**
 * Whether a task can run here — and, where it cannot, whether that can change.
 *
 * The original rule was one boolean and §18.1's *a task that means nothing on
 * the open file is absent, not disabled*. That is right about a disabled row
 * being a promise a file cannot keep, and wrong about there being only one kind
 * of "cannot". Two situations were collapsed into it:
 *
 * - **A metagenome task on a plain cooler.** The file has no `/genomes` table
 *   and never will; nothing the reader does here produces one. Listing it would
 *   be offering something that is not on the menu, which is what the doctrine is
 *   about. Still `absent`.
 * - **APA before a loop set is loaded.** The task applies perfectly well to this
 *   file — it is one drag-and-drop away — and hiding it means a reader who does
 *   not already know the app does aggregate peak analysis never finds out that
 *   it does. Absence was teaching the wrong thing: not *this file cannot*, but
 *   *this feature does not exist*.
 *
 * So the second is `waiting`, with a sentence naming what it needs. A greyed row
 * reading "load a loop set" is not an unkept promise; it is the menu.
 */
export type TaskAvailability =
  /** Run it. */
  | { state: 'ready' }
  /**
   * It applies here, once the reader supplies something. Listed, greyed, and the
   * sentence is shown under the row — so write it as an instruction rather than
   * a diagnosis: *Load a loop set (BEDPE) or a feature set to aggregate over.*
   */
  | { state: 'waiting'; needs: string }
  /** Nothing the reader can do makes this task meaningful here. Not listed. */
  | { state: 'absent' }

/** The everyday answer, so a task with nothing to check reads as one line. */
export const READY: TaskAvailability = { state: 'ready' }

/** Listed and greyed, with a sentence saying what would make it runnable. */
export function waitingFor(needs: string): TaskAvailability {
  return { state: 'waiting', needs }
}

/** What every task that reads the matrix says when there is no map open. */
export const NEEDS_MAP = 'Open a contact map — this one reads the matrix itself.'

/** Everything one run produced, and what it cost in wall clock. */
export interface TaskResult {
  outputs: TaskOutput[]
  provenance: Provenance
  /**
   * Things the reader should know that are not errors.
   *
   * "Phasing was ambiguous (r = 0.04)", "412 of 5,000 windows were dropped for
   * missing data". A task that silently drops a fifth of its input and reports a
   * clean number is a task that lies, and there is nowhere else to put this.
   */
  notes: string[]
  ms: number
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

/**
 * What a task will cost, stated before it is allowed to start.
 *
 * Three classes and no fourth (§18.6). **free** is computed from a block already
 * in memory. **bounded** is a few range requests. **scan** is a streaming pass,
 * and is therefore gated exactly as the genome × genome overview is (§7.3):
 * explicit action, a progress bar, a cancel, and a figure in requests and bytes
 * beside the button. Expensive things are offered with their price, not hidden
 * and not refused.
 */
export interface CostEstimate {
  class: 'free' | 'bounded' | 'scan'
  /** Range requests, or `null` where the file is local and there are none. */
  requests: number | null
  bytes: number | null
  /** One line beside **Run**, already worded for a human. */
  note: string
  /**
   * A refusal, where the parameters ask for something that cannot be done.
   *
   * The bin-count gate on a correlation matrix is the case this exists for: it
   * names the bin count, the bytes and the way out, in `checkDenseSize`'s voice,
   * rather than quietly coarsening. Set means **Run** is disabled.
   */
  refusal?: string
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** One sequence of the open file, as a task and a form need it. */
export interface ContextContig {
  name: string
  length: number
  /** Absolute bin this contig starts at. */
  startBin: number
  bins: number
  /** Index into {@link AnalysisContext.genomes}, or `-1` for a plain cooler. */
  genome: number
}

/** One genome of an open metacool. */
export interface ContextGenome {
  name: string
  /** Absolute bin range, half-open. */
  extent: Extent
  contigs: number
}

/**
 * What the panel and the drawer know before anything runs.
 *
 * Assembled on the main thread from the open file and the loaded annotations. It
 * is what {@link AnalysisTask.appliesTo} decides on, what the form's dropdowns
 * are filled from, and what {@link AnalysisTask.estimate} prices against.
 */
export interface AnalysisContext {
  uri: string
  layout: LayoutKind
  hasGenomes: boolean
  hasWeights: boolean
  scoreColumns: string[]
  binsize: number
  nBins: number
  /**
   * Whether there is a contact map at all.
   *
   * `false` in a 1D browser session (§5.8), where an assembly is open, tracks
   * can be loaded and compared, and there is no matrix — so `binsize` and
   * `nBins` are `0`, `contigs` comes from the assembly, and every task that
   * reads the matrix is `waiting` rather than absent. The zeros never reach a
   * runner, because a `waiting` task cannot be run.
   */
  hasMap: boolean

  contigs: ContextContig[]
  genomes: ContextGenome[] | null
  /** Every loaded annotation, for the four entry parameter kinds. */
  entries: readonly AnnotationEntry[]
  /** `null` on a view that has no map — the file picker, a table. */
  framing: AnalysisFraming | null
  /** Whether the mounted view is holding a dense block covering the framing. */
  blockLoaded: boolean
  /** Bytes of that block, so the runner can decide whether copying it is free. */
  blockBytes: number
  /**
   * Cells in a single-cell container, and `0` for every other file (§3.8).
   *
   * Carried so that a task whose unit is a cell can be **absent** rather than
   * waiting on a file that has none, which is §8.5's rule — and so that its
   * estimate can be in cells, which is the only honest denominator for a read
   * whose cost is linear in them.
   */
  cells?: number
  /** How many of those the reader has ticked; equal to {@link cells} when none is. */
  activeCells?: number
  /**
   * The ticked cells by name, only when they are **fewer than all of them**.
   *
   * What a `metacooler-run` line needs that the two counts above cannot give
   * it: a task over an `.scool` is a task over the sum of the ticked cells
   * (§3.8), so a command that named the file and not the cells would repeat a
   * different run. Absent when every cell is ticked, which is the default a
   * shell also takes.
   */
  selectedCells?: readonly string[]
  /**
   * The file's resolution ladder in base pairs, finest first.
   *
   * Empty for a plain `.cool` and a replicate collection, which have no rungs
   * to move between. Here so that a task priced past what a resolution can
   * bear can name the rung that would bear it, rather than say "coarser".
   */
  resolutions?: number[]
  /**
   * The other maps of a deck, for the one task whose unit is a pair of files.
   *
   * Absent in a session with one map, which is what makes that task *waiting*
   * rather than ready. The bin size is here because it is the one thing §16's
   * navigation lock deliberately does **not** make equal — the lock's currency
   * is base pairs, so a deck can hold a 1 kb map beside a 5 kb one — and a
   * stratified correlation is meaningless across two grids.
   */
  peers?: Array<{ label: string; uri: string; binsize: number }>
}

// ---------------------------------------------------------------------------
// The task
// ---------------------------------------------------------------------------

/**
 * Where a task's work happens.
 *
 * Almost everything runs in the analysis worker, which owns a mount of its own
 * so that nothing it does can make the map wait (§18.3). The exception is the
 * handful of tasks whose whole input is bigWigs and feature sets: those already
 * live in the annotations worker, which already takes many regions in one
 * request, and moving N × W floats to a third thread to average them there would
 * be the point missed.
 */
export type TaskVenue = 'analysis' | 'annotations'

/** Which heading a task sits under in the panel. */
export type TaskGroup = 'map' | 'tracks' | 'metagenome'

export interface AnalysisTask {
  /** Stable. Storage, provenance and the config all key on it; never a title. */
  id: string
  title: string
  /** One line for the panel row. */
  blurb: string
  group: TaskGroup
  venue: TaskVenue
  /**
   * Bumped when the numbers this task produces change meaning.
   *
   * Not when the code changes — when the *answer* does. A stored result or a
   * shared session naming an older version is a result whose provenance line
   * says so, which is the difference between a reproducible figure and a
   * plausible one.
   */
  version: number
  /**
   * Whether this task reads **another map** beside the one that is mounted.
   *
   * Declared on the descriptor rather than inferred: the shell has one file
   * positional, so a task whose question is about two takes the others under
   * `--against` (`cli/main.ts`) and is refused before a file is opened when
   * none is named, rather than failing inside a runner afterwards; and the
   * command writer (`analysis/cliCommand.ts`) knows to write them. It is one
   * task (§16, §18.8) and it is a property of what the task *is*.
   */
  needsPeers?: boolean
  /**
   * Whether this task can run on what is open, and if not, why not.
   *
   * See {@link TaskAvailability}. It replaced a boolean `appliesTo`, which could
   * only say *absent* — and said it about two situations that are nothing alike.
   */
  availability(context: AnalysisContext): TaskAvailability
  params: readonly ParamSpec[]
  /** What comes out, so the row and the drawer know what to offer. */
  outputs: ReadonlyArray<TaskOutput['kind']>
  /** Ids of tasks whose results are inputs to this one (§18.2's composites). */
  requires?: readonly string[]
  estimate(context: AnalysisContext, params: Params): CostEstimate
}
