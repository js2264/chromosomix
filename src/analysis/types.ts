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
import type { DevFeature } from '../state/devFeatures'
import type {
  AnnotationEntry,
  AnnotationKind,
  AnnotationPayload,
  OverlayShape,
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
 * The word beside a number box, which is the whole of what says what it is.
 *
 * **A setting about the matrix takes `bins`** — it is a count of the file's own
 * cells, and asked in base pairs it was divided by the bin size before it meant
 * anything, differently on every rung of an `.mcool` (§18.2). `bp` is left for
 * the one quantity bins are not a unit of: a **1D track's** flank, sampling step
 * or window, which is the same length of genome at every resolution and may be
 * asked for in a session with no contact map at all.
 *
 * `''` is the unitless case — a count of components, a number of quantiles, a
 * count of diagonals whose label says so — and `%` is drawn with its sign.
 */
export type ParamUnit = '' | 'bp' | 'bins' | '%' | 'x'

interface ParamBase {
  /** Stable. Used in `Params`, in storage and in provenance; never a label. */
  key: string
  label: string
  /**
   * One sentence, drawn to the right of the control on its own row.
   *
   * Beside rather than under, which is what `.param-row`'s two columns have
   * always done and what this line used to describe wrongly. The consequence is
   * a length: a sentence of about ninety characters is one line at the drawer's
   * width, and a paragraph here pushes the Run button off the screen. What needs
   * more than a sentence belongs in the option's own `hint`, which the form puts
   * in its tooltip, or nowhere.
   */
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
   * Whether the file in hand asks this question at all.
   *
   * {@link needsNoGenomes} generalised, for a question some files have already
   * answered. The case is P(s)'s `.pairs` (§18.8): a map binned from one on
   * open had its four orientations counted in that same pass (§3.7), so a
   * control asking the reader for the file they opened it from is a question
   * whose answer is on screen — and it read as if the curves could not be had
   * without one. `false` hides the control as `needsNoGenomes` does, and
   * {@link settled} is what the run is then recorded as.
   *
   * Pure, and about the file rather than the form: `when` is for the other
   * answers on the form.
   */
  askedOf?(context: AnalysisContext): boolean
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
  /**
   * A default that is the context's to decide, for a number whose right answer
   * moves with what is open — a bin size that is the open map's resolution, and
   * some other length where no map is open.
   *
   * The value is then `null` until the reader types one, so it follows the
   * context instead of freezing at whatever the form was first opened on: the
   * form shows what `null` stands for, and a run is handed the number itself
   * ({@link resolveSeeds}), so its record says what was read. {@link default} is
   * what a caller with no context — a shell — falls back on.
   */
  seed?(context: AnalysisContext): number
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
  /**
   * The empty choice is offered, and the value may be `null`. On a `multiple`
   * one, every box unticked is an answer (`[]`) the form keeps, where a required
   * list is ticked back to the star.
   */
  optional?: boolean
  /** Label for the empty choice. Only read when `optional`. */
  noneLabel?: string
  /**
   * Optional only: start on the empty choice rather than on the star.
   *
   * For an input that changes what a task computes by being there at all — a
   * track the compartments are phased by, the coverage an origin call breaks a
   * tie with. The first bigWig loaded is a guess at either that nobody made, and
   * a ChIP track taken for coverage gives a ratio that looks like any other.
   */
  startsEmpty?: boolean
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

/**
 * A file the task **reads** and the app does not open — a `.pairs` for P(s)'s
 * four orientations (§18.8), whose records matter and whose map does not.
 *
 * Drawn as a drop area that is also a button, with an address box under it: a
 * local file is dropped on it or chosen through the picker it opens, and a file
 * somewhere else is named by URL. Not an {@link EntryParam}, because nothing is
 * loaded — no lane, no row on a card, no map — and a `.pairs` dropped on the app
 * itself is *opened*, as a map, which is a different gesture with a dialog in
 * front of it.
 *
 * **The value is a string, and a `File` is not one.** An address is its own
 * value. A local file's value is its **name**, which is what the provenance, a
 * table's header and the `chromosomix` line can say about it; the `File`
 * itself is held beside the form by the runner (`AnalysisRunner.holdFile`),
 * since a parameter set is posted, stored and printed and a `File` survives only
 * the first of those. A name whose file is no longer held — a form recalled
 * after a reload — is emptied rather than trusted.
 */
export interface FileParam extends ParamBase {
  kind: 'file'
  /** Name endings the drop area takes, lowercase: `.pairs`, `.pairs.gz` … */
  accept: readonly string[]
  /** What the drop area says while it is empty. */
  prompt: string
  /** Shown in the empty address box. An example, never a restatement. */
  placeholder?: string
}

/** Whether a {@link FileParam}'s value is an address rather than a local file's name. */
export function isAddress(value: string): boolean {
  return /^(https?|s3):\/\//i.test(value.trim())
}

/**
 * A locus, in the syntax the views' own boxes take. Defaults to the framing.
 *
 * **The typed form of §26.1** — 1-based and inclusive, digits grouped or not —
 * wherever the value lives: in the form, in a result's provenance, in a
 * workspace, on a `chromosomix` line. It becomes cooler's 0-based half-open
 * grammar in one place, `analysis/job.ts`'s `runnerParams`, as a job is handed
 * to its runner, so no runner reads it any other way and no record holds the
 * machine form.
 *
 * **A locus and nothing else.** This kind used to have a `sequences` flag that
 * turned the box into a dropdown of the file's own sequence names, whose first
 * option read *every sequence* — so five tasks asked *which sequences do I run
 * on* with a select while four others asked it with a column of tick boxes, and
 * a reader met both shapes in one column. The tick boxes won and they took the
 * question with them ({@link SequencesParam}): a dropdown can answer *every* or
 * *one* and cannot say *these three*, which a whole-genome run and a per-sequence
 * run are both special cases of.
 *
 * What is left here is the question a list of names cannot answer: a **locus**.
 * A 4C anchor is a window, a structure task's *distance to* is a point on the
 * map, and the reconstruction takes a comma-separated list of them. Narrowing
 * any of those three to a whole sequence would remove the task's point.
 */
export interface RegionParam extends ParamBase {
  kind: 'region'
  default?: string
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
   * Offer a *pick on map* button beside the box.
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
 * **Which sequences to run on**, ticked.
 *
 * The one shape for that question, and it used to be two: this, and a
 * {@link RegionParam} whose dropdown offered *every sequence* or one of them.
 * Both asked the same thing and a reader met both in one column, so the tick
 * boxes took it over — they are the superset, since *all of them* and *one of
 * them* are two of the answers a list of tick boxes can give and *these three*
 * is a third that a dropdown has no way to express.
 *
 * It is not only a wider picker: for some tasks the set is the *unit* of the
 * answer rather than a filter on it. Compartments is the case — a correlation
 * over four chromosomes' cis and trans blocks together is a genome-wide
 * eigenvector, which is not any of the four per-chromosome ones and cannot be
 * assembled from them — while insulation, the index, the HiC score, P(s) and the
 * scalogram read each ticked sequence on its own and emit one lane or one curve
 * apiece. The descriptor does not distinguish the two; the runner does.
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
 * Never answered at all is `null`, and it means **every sequence** — the form
 * resolves it to every name on the way in, so a task with one of these starts
 * genome-wide, and a job that never met a form keeps the `null` and is read the
 * same way. That last half was the half that was missing: the runners took
 * anything that was not an array as `[]`, so `chromosomix compartments
 * file.cool` refused itself for not having ticked a box in a drawer a shell has
 * not got. `analysis/context.ts`'s `tickedContigs` and `analysis/job.ts`'s
 * `tickedSequences` are the two readings of this value, one per side of the
 * worker boundary, and both keep the three answers apart.
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
  | FileParam
  | SequencesParam
  | SeedParam

/** The defaults a task starts with, before memory or a session overrides them. */
export function defaultParams(specs: readonly ParamSpec[]): Params {
  const out: Record<string, ParamValue> = {}
  for (const spec of specs) {
    switch (spec.kind) {
      case 'number':
        // Unanswered where the context decides it, so it keeps deciding it.
        out[spec.key] = spec.seed === undefined ? spec.default : null
        break
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
      // Nothing chosen, as an empty text box is.
      case 'file':
        out[spec.key] = ''
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
        // `''` is the empty choice already answered, which the form keeps; an
        // optional list is `null` until answered, and `[]` once every box is
        // unticked, which the form keeps too.
        out[spec.key] =
          spec.multiple === true
            ? spec.optional === true
              ? null
              : []
            : spec.optional === true && spec.startsEmpty === true
              ? ''
              : null
        break
      case 'column':
        out[spec.key] = null
        break
    }
  }
  return out
}

/**
 * The parameters with every context-seeded number answered (see
 * {@link NumberParam.seed}) — what a run is handed, so its record names the
 * number that was read rather than the absence of one.
 */
export function resolveSeeds(specs: readonly ParamSpec[], context: AnalysisContext, params: Params): Params {
  const out: Record<string, ParamValue> = { ...params }
  for (const spec of specs) {
    if (spec.kind !== 'number' || spec.seed === undefined) continue
    const held = out[spec.key]
    if (typeof held === 'number' && Number.isFinite(held)) continue
    out[spec.key] = spec.seed(context)
  }
  return out
}

/**
 * Whether `spec` is shown, given the rest of the form and the file.
 *
 * Two rules and they are different in kind: `when` is about the other answers on
 * this form and is re-read on every keystroke, while `needsNoGenomes` and
 * `askedOf` are about the file and change only when the drawer is handed
 * another one. All end in the same place — a wrapper out of the document, with
 * its control and its state kept — so a form does not have to know which of
 * them hid a row.
 */
export function paramVisible(
  spec: ParamSpec,
  params: Params,
  context: AnalysisContext,
): boolean {
  if (!paramAsked(spec, context)) return false
  return spec.when === undefined || spec.when(params)
}

/** Whether this file asks `spec` at all — the half of {@link paramVisible} about the file. */
export function paramAsked(spec: ParamSpec, context: AnalysisContext): boolean {
  if (spec.needsNoGenomes === true && context.hasGenomes) return false
  return spec.askedOf === undefined || spec.askedOf(context)
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
  /**
   * Where the reader has declared each sequence's replication **origin**, in
   * base pairs, 0-based, by this file's own names. Absent where none is.
   *
   * The same kind of fact as {@link circular} and carried for the same reason:
   * it is about the molecule rather than the window, and it changes the numbers
   * of every task that reads a bacterial chromosome in the frame of its two arms
   * — the arm-frame expectation of compartments and the inter-arm alignment
   * (§8.15, §18.8) — so it belongs in the provenance of what they produce. Filled
   * by the *Origin and terminus* task for every sequence the reader has not set
   * one on, and shown in the Chromosomes table.
   */
  origins?: Readonly<Record<string, number>>
  /**
   * The total the map was drawn to when the view was read (§6.5): a subsample
   * or an oversample of the file to this many contacts. Absent is the file as
   * stored.
   *
   * In the framing because it is in every number a task produces — a P(s) at
   * ten million contacts is not the curve at a hundred and seventy-nine million
   * — and so in the provenance of each, in the command line that reproduces it,
   * and in the test that decides whether the block on screen may stand in for a
   * read.
   */
  contacts?: number
  /**
   * The edit of the reference the map was drawn through (§27.7), as its
   * fingerprint (`genome/edit.ts`); absent for the file as it is. A result is of
   * the edited assembly it was computed on, and the next edit makes it stale.
   */
  edit?: string
  /**
   * The resolution the reader added that the map was drawn at (§3.4), in base
   * pairs, where it was drawn at one; absent at a rung the file stores. Then it
   * is {@link binsize} too, and {@link rows} and {@link cols} count its bins:
   * every task reads the map summed to it, as the picture is, and a result
   * measured at the file's own rung under a header naming this one would be
   * the wrong number with the right label. In the provenance, the staleness
   * test and the command line (`--coarsen`) for the reason {@link contacts} is.
   */
  coarsen?: number
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
   *
   * `bars` is that argument one step further. A series whose x is a **list** —
   * one value per sequence, per sample, per MAG — has nothing between its
   * samples at all, and the mark that says so is a bar standing on a baseline.
   * It goes with {@link CurveOutput.xTicks}, which is what names the list.
   *
   * `violin` is a series with no x at all: a sample of one quantity, drawn as
   * its distribution beside the other series' (§18.13) — a group's values in
   * *Signal by group*. A figure every series of which says so opens as violins,
   * and the reader's mark control can turn them into boxes or a histogram.
   */
  mark?: 'line' | 'points' | 'bars' | 'violin'
  /**
   * The stack this series shares, where the bars are parts of one whole.
   *
   * Two series naming the same stack are drawn one above the other, so a
   * sequence's cis and trans fractions — which sum to one by construction — are
   * one bar split in two rather than two bars a reader has to add up.
   *
   * **Only bars stack.** The same field on a pair of lines would draw an upper
   * line that is the sum of two quantities under an axis claiming it is one of
   * them, which is what a stacked line chart invites and what nothing here
   * wants; `figures/option.ts` reads this for a bar and ignores it otherwise, so
   * a reader who restyles the figure to a line gets two lines.
   */
  stack?: string
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
  /**
   * What the points of the abscissa are called, where they are a list.
   *
   * One name per x, in the order the values are in — a sequence per bar on the
   * cis/trans fractions, and `MatrixOutput.xTicks`'s job on an axis that has
   * one series instead of a grid. Absent for every curve whose x is a
   * *quantity*: a separation, a position, a rank.
   *
   * The x values stay numbers, and that is the decision rather than an
   * accident. A category axis would have cost this abscissa its wheel, its
   * marquee and the two windows a reader types (§18.7) — which a four-hundred
   * contig metagenome needs far more than a sixteen-chromosome yeast does — so
   * the names are a *spelling* of an ordinary numeric axis, the way a bin index
   * is spelled in base pairs, and the figure goes on zooming and exporting the
   * way every other figure does.
   */
  xTicks?: string[]
  /**
   * The output already compares **every map on screen** — a reproducibility
   * run's lines, its matrix and its tables, each about every pair of maps.
   *
   * Every map's run of such a task computes the same comparison, so the
   * all-maps tab (`analysis/combine.ts`) shows it **once** — from the run that
   * compared the most maps — rather than overlaying one copy per map, which
   * drew every pair twice under two names, or stacking one table per map,
   * which listed every pair once per map.
   */
  acrossMaps?: boolean
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
/** A dot plot's streaks, one entry each, and the two axes they are measured along (§28.2). */
export interface DotplotStreaks {
  /** What each axis is — the sequence set's name — and its sequences in order, with their lengths. */
  x: { label: string; names: string[]; lengths: number[] }
  y: { label: string; names: string[]; lengths: number[] }
  /** Extents on each axis, half-open, in bases along the concatenated axis. */
  x0: Float64Array
  x1: Float64Array
  y0: Float64Array
  y1: Float64Array
  /** `1` the same way round, `-1` the other. */
  strand: Int8Array
  anchors: Int32Array
}

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
   * Whether the cells must be square, or the picture should take the box.
   *
   * `'square'` — the default, and what everything with a diagonal needs. A
   * saddle, a pileup, a cis/trans square and a correlation heatmap all have the
   * *same quantity on both axes*, and they are read by comparing one corner
   * against the other: a corner stretched 40% along one axis looks stronger
   * than the one opposite it, so the aspect of such a picture must not be
   * decided by how wide the reader dragged the drawer.
   *
   * `'fill'` — the rows are a **list**, not a coordinate: one per feature,
   * strongest first, against distance along the abscissa. Nothing is compared
   * across the diagonal because there is no diagonal, and the picture the
   * literature draws is a tall block the width of the panel, under a profile it
   * shares an abscissa with. Square cells there give three thousand rows a
   * thousand columns' worth of width — a narrow ribbon in a wide card.
   */
  aspect?: 'square' | 'fill'
  /**
   * A picture read like a map rather than a chart — a dot plot's two
   * assemblies end to end (§28): as large as the card lets it be, its square
   * cells a fraction of a pixel wider where that is what fills it, each one's
   * edges on whole pixels. Absent, a cell is a whole number of pixels, which
   * leaves a picture of four hundred cells four hundred pixels wide in a card
   * three times that.
   */
  large?: boolean
  /**
   * A dot plot's streaks as the lines they are (§28.2): where present, the
   * figure draws these rather than the cells — on screen at any zoom, sharp,
   * the one under the pointer named on both axes, and in a PNG or a PDF as the
   * window on screen — and the cells stay the output's, in its TSV.
   */
  streaks?: DotplotStreaks
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
  /**
   * Profiles drawn along the picture's two edges; see {@link MatrixMargins}.
   *
   * Absent almost everywhere, because almost nothing has a second quantity that
   * shares an axis with the matrix. A pileup does, and it is the commonest
   * figure in the literature this task is a viewer for: the aggregate contact
   * map with the aggregate ChIP signal above it and beside it, which is what
   * turns *these places touch* into *these places touch, and this is what is
   * bound where they do*.
   */
  margins?: MatrixMargins
  /**
   * Sequences laid end to end along an axis, in its cells — a rule between two
   * and the name of each under it: a dot plot's two assemblies (§28), whose
   * ticks are sequences rather than a scale. Where given, they take the place
   * of that axis's ticks.
   */
  xSegments?: MatrixSegment[]
  ySegments?: MatrixSegment[]
  /** See {@link CurveOutput.acrossMaps}. */
  acrossMaps?: boolean
}

/** One sequence along an axis of a {@link MatrixOutput}: its name, and the cells it spans, fractional. */
export interface MatrixSegment {
  label: string
  from: number
  to: number
}

/**
 * One profile drawn along an edge of a {@link MatrixOutput}.
 *
 * `values` is one number per cell of the axis it runs along — `ncols` on the
 * top, `nrows` down the right — so it lines up with the picture by construction
 * rather than by a second resampling in the renderer. `NaN` is a gap and is
 * drawn as one.
 */
export interface MarginProfile {
  name: string
  values: Float64Array
  /** A colour of the caller's choosing; the figure's own palette otherwise. */
  colour?: string
}

/**
 * The profiles along a matrix's top and right edges.
 *
 * **Top and right**, not top and left, and that is the convention every aggregate
 * figure in this literature uses: the colour bar is on the right in this
 * application, so the right-hand profile sits between the picture and the bar,
 * and the reader's eye leaves the pileup along the same two edges the anchors
 * are on.
 *
 * Each side is a list because a reader comparing two marks — CTCF and cohesin,
 * say — wants both above one pileup rather than two pileups. Each is normalised
 * on its own, because two tracks in two units have no common axis; what the
 * figure promises is the *shape* along the window, which is the whole of what a
 * marginal profile is read for.
 */
export interface MatrixMargins {
  /** Along the columns, above the picture. One value per column. */
  top?: MarginProfile[]
  /** Along the rows, to the right of the picture. One value per row. */
  right?: MarginProfile[]
}

/** A column of a {@link TableOutput}. */
export interface TableColumn {
  key: string
  label: string
  kind: 'text' | 'number'
  /** Decimal places for a number column; integers when absent. */
  digits?: number
  /**
   * Written in scientific notation where the fixed digits would print it as
   * zero — a P of 10⁻²¹ is not `0.000000`. For a column whose values span
   * orders of magnitude below its digits and whose smallness is the point.
   */
  scientific?: boolean
  /**
   * A coordinate on a sequence, printed as every coordinate on the screen is
   * (§26.1, §18.7): grouped as en-US whatever the reader's locale, and a
   * **start** — a feature's, a bin's, a summit's base — one more than it is
   * held, 1-based.
   *
   * Held the way the file it is saved to holds it: a table whose first columns
   * are a sequence, a start and an end is BED-shaped, and this app's own reader
   * takes such a TSV 0-based (§8.3), so a start written 1-based would come back
   * a base to the right when the table is dropped on a map. An end is the same
   * number either way, half-open or inclusive, so only its grouping is the
   * screen's. The TSV's `# columns` line marks a start `(0-based)`.
   */
  coordinate?: 'start' | 'end'
  hint?: string
}

export interface TableOutput {
  kind: 'table'
  id: string
  label: string
  columns: TableColumn[]
  rows: Array<Record<string, string | number>>
  /** See {@link CurveOutput.acrossMaps}. */
  acrossMaps?: boolean
}

/**
 * Intervals a task called: boundaries, domains, flagged contigs, loops.
 *
 * The payload is exactly what a parsed file would have produced, so it is
 * offered as a new row of the Tracks card and is drawn the moment it arrives —
 * as a 1D track or on the map, whichever its display opens on, since a called
 * boundary the reader cannot see is a called boundary nobody will check.
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
  /**
   * Which surface the set opens on (§18.7): a **1D track** of segments beside
   * the map, or an **overlay** on the map it was called from.
   *
   * One row, on one surface, which the row's *display* moves between; this is
   * only where it starts. A set read against a lane opens as a track under it —
   * peaks under their coverage, boundaries under the insulation score, A/B
   * segments under E1 — and a set that is a picture of the map opens on it:
   * domains as corners along the diagonal, loops as rings. Absent is the track
   * for intervals and the overlay for pairs, whose anchors along one axis are a
   * reading a reader may want and not the picture a loop is.
   */
  display?: 'lane' | 'overlay'
  /**
   * How a set of intervals is drawn on the map, whichever surface it opens on
   * (`OverlayShape`): `point` or `border` for a set of places, whose look the
   * reader then chooses between, and `corner` for a set of extents. Absent is
   * the corner.
   */
  look?: OverlayShape
  /**
   * Where the set's **track** goes in the list (§18.7).
   *
   * A track is read against the lane it came from: a peak set under the
   * coverage it was called on, the A/B segments under the eigenvector that made
   * them. `under` names that row, as one of this run's own profiles (`output`)
   * or as a loaded row (`entry`); absent, it goes under the last profile the run
   * produced, or on the computed tracks' edge where it produced none
   * (`analysis/surfaces.ts`). The slot is the row's on either surface.
   */
  lane?: { under?: { output: string } | { entry: string } }
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

/**
 * What every task that reads the matrix says when there is no map open.
 *
 * Four words, and the second clause it used to carry — *this one reads the
 * matrix itself* — is gone. Ten of the sixteen tasks return this string, so on a
 * 1D-browser session the column printed one sentence ten times over and the one
 * gate that differed (APA's loop set) was lost in it. The trailing clause was
 * also an explanation rather than an instruction: what the task reads is the
 * blurb's job, and a reader who has no map does not need to be told why.
 *
 * The repetition itself is answered one level up, in the column: a group whose
 * every waiting row carries the same sentence prints it once under the heading
 * (§18.1, `AnalysisPanelCard`).
 */
export const NEEDS_MAP = 'Open a contact map.'

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
  /**
   * One line beside **Run**, already worded for a human: **a price and nothing
   * else.**
   *
   * Every scan's note used to end *progress is reported as it goes and it can be
   * cancelled at any point* — eighteen copies of a promise the progress bar and
   * the cancel button beside it make by existing. It also filled the line a
   * reader checks before spending compute with reassurance instead of a figure,
   * which is the one thing they came to that line for. So the sentence says what
   * will be read — *one pass over the whole pixel table*, *154 strips along their
   * diagonals*, *up to 40 MB at a time* — and the class is said in those words
   * rather than in a colour (§26.5): a price is `--text-dim` whatever it costs,
   * and `--danger` belongs to {@link CostEstimate.refusal} alone.
   *
   * No trailing full stop is needed: {@link costText} joins the requests and the
   * bytes onto the end with a middle dot and strips one if it finds it.
   */
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
  /**
   * Where a task's recipe and its figures' styles are remembered for this map:
   * the session's own key for the file (`Session.memoryKey`, a tab and a file),
   * which is what a saved workspace's `analysis` and `figures` are written from
   * and put back under (§18.2). They were kept under {@link uri} instead — the
   * file with its resolution — so a workspace opened its tasks on their
   * defaults and saved none of the recipes it was run with. Absent outside a
   * session (the command line, a test), and the uri is then the key.
   */
  memoryKey?: string
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
   * What a `chromosomix` line needs that the two counts above cannot give
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
  /**
   * The file's circular declarations and origins (§8.15), as a framing carries
   * them — here as well because a track task can run where there is **no**
   * framing, from the Chromosomes table or a 1D browser, and the one the runner
   * makes for it there must carry them too. An *Origin and terminus* run from the
   * table read a declared circle as a line, and a line splits an origin near its
   * first base between its two ends.
   */
  circular?: readonly string[]
  origins?: Readonly<Record<string, number>>
  /**
   * The `.pairs` this map was binned from on open (§3.7), where it was one.
   *
   * `orientation` is whether that pass counted the four orientation curves —
   * it did wherever the records carried strands — which is what lets P(s) take
   * them from the import instead of asking for the file the reader opened
   * (§18.8). Absent on every map that was opened rather than binned.
   */
  binnedFrom?: { name: string; orientation: boolean }
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

/**
 * Which card a task sits in, in the Analysis panel.
 *
 * **By the dimension the question is about**, not by the file it reads: a task
 * is 2D when its subject is the contact matrix, 3D when its subject is a model
 * of beads in space, 1D when its subject is a track or an interval set along
 * the sequence. That cut puts *aggregate peak analysis* with the matrix it
 * piles up rather than with the loop set that says where, and *metaplot* with
 * the track it averages rather than with the features it averages over — each
 * beside the thing a reader would go looking under.
 *
 * `metagenome` is the one group that is not a dimension, and it stays one
 * because its four tasks are not about a dimension: a MAG is a *bin of an
 * assembly*, and *split-MAG detection* belongs beside *MAG purity* rather than
 * beside *compartments*. It is absent on a file that has no genomes, so the
 * card never appears where it would mean nothing.
 */
export type TaskGroup = '2d' | '3d' | '1d' | 'metagenome'

export interface AnalysisTask {
  /** Stable. Storage, provenance and the config all key on it; never a title. */
  id: string
  title: string
  /** One line for the panel row. */
  blurb: string
  /**
   * The other names a reader looks for the task by, which neither its title
   * nor its blurb says — *TAD* for insulation, *pileup* for APA, *A/B* for the
   * compartments — matched by the filter over the list as its title is (§18.1).
   */
  keywords?: readonly string[]
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
   * Whether this task reads **no map** at all — two sequence sets against
   * each other (§28) — so the drawer's heading names no framing, and a view
   * that has moved leaves the result standing rather than stale: nothing it
   * was computed from has moved.
   */
  mapless?: boolean
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
  /**
   * The dev feature this task belongs to (§29), if it is one: absent from the
   * Analysis panel — not greyed, not waiting — while the switch is off. The
   * command line runs it regardless, having no switch.
   */
  dev?: DevFeature
  estimate(context: AnalysisContext, params: Params): CostEstimate
}

/**
 * Whether a task reads a contact map, or only the tracks and sequences loaded.
 *
 * Every task in the annotations venue is the second kind (§18.3): its runner is
 * handed the loaded entries and a framing and has no matrix to read, which is
 * the whole of what puts it in that worker. So a deck changes nothing about it.
 * Four maps on screen are four answers to a P(s) and one answer to a metaplot,
 * and the drawer offers it one Run rather than *run on ★* and *run on all four*
 * (§18.1), which queued the same tracks four times and filed four copies of one
 * lane under four maps' names. `mapless` says it outright for the one task that
 * reads no map even in its framing (§28); the venue says it for the rest.
 */
export function readsMap(task: Pick<AnalysisTask, 'venue' | 'mapless'>): boolean {
  return task.venue === 'analysis' && task.mapless !== true
}
