/**
 * The one form every task is configured through.
 *
 * §18.2 makes a claim that is easy to write and easy to lose: **adding a task is
 * adding a descriptor, never adding a screen.** This module is the whole of what
 * makes it true. A {@link ParamSpec} list goes in, controls come out, and no task
 * anywhere in `analysis/tasks/` owns a line of DOM. The moment one kind of
 * parameter is not general enough — a metaplot's flank, a saddle's quantile
 * count, a pileup's ranking column — the task that needs it grows a bespoke form
 * beside this one, and from then on there are two places to add a control, two
 * places a label goes stale, and sixteen tasks that no longer look alike.
 *
 * Three of the rules below are here because the obvious implementation is wrong
 * in a way that is only discovered by typing into it:
 *
 * - **A bound is applied when a number is committed, never while it is typed.**
 *   Clamping on every keystroke makes `10` unreachable when the floor is `2`,
 *   because the `1` is rewritten to `2` before the `0` arrives.
 * - **A hidden control keeps its value.** `when` decides what is *shown*, not
 *   what is *stored*, so turning distance-matched controls off and on again
 *   returns the numbers that were typed rather than the descriptor's defaults.
 * - **A column list follows the dropdown above it.** Picking a different peak
 *   file and being left with the previous file's column names is the bug
 *   {@link ColumnParam} exists to prevent, and it can only be prevented here.
 *
 * The controls themselves are the ones the three panels already use — the cards,
 * the two-column label grid, the mark buttons whose border appears when they are
 * on — because a drawer that invents a second visual language is a drawer that
 * reads as a different application bolted to the side of this one.
 */

import { makeRandom } from '../analysis/random'
import { devFeature } from '../state/devFeatures'
import { isAddress, paramAsked, paramDerived, paramVisible } from '../analysis/types'
import type {
  AnalysisContext,
  ChoiceOption,
  ChoiceParam,
  ColumnParam,
  EntryParam,
  FileParam,
  NumberParam,
  ParamSpec,
  ParamValue,
  Params,
  RegionParam,
  SequencesParam,
  SeedParam,
  TextParam,
  ToggleParam,
} from '../analysis/types'
import type { HeldFile } from '../analysis/runner'
import { ANNOTATION_KINDS, DETAIL_SEP, isIntervalSet } from '../annotations/types'
import type { AnnotationEntry, AnnotationKind } from '../annotations/types'
import { button, dragHasFiles, el, fmt } from './dom'
import { chooseFiles, filesFrom } from './chooseFiles'
import { dragHasFileRow, readFileDrag } from './fileDrag'
import { formatLocus } from '../genome/assembly'
import { armPick, disarmPick, isArmed, lastPick, subscribePick } from './mapPick'
import { iconButton } from './icons'

/**
 * The options a pick-one parameter offers *this* file.
 *
 * A cooler has no `/genomes` table, so "per genome" is not a narrower scope on
 * one — it is a question the file cannot answer. It used to be offered anyway
 * and refused at Run, on the argument that filtering per file would mean
 * building the descriptor per file. It does not: the descriptor still says which
 * options need genomes, and this reads that rule. What is refused at Run is a
 * *stored* session naming one, which is the case the old argument was really
 * about.
 */
function optionsFor(spec: ChoiceParam, context: AnalysisContext): readonly ChoiceOption[] {
  return spec.options.filter((option) => {
    if (option.needsGenomes === true && !context.hasGenomes) return false
    if (option.needsKinds === undefined) return true
    return context.entries.some(
      (entry) =>
        entry.status !== 'error' &&
        (option.needsKinds as readonly string[]).includes(entry.kind),
    )
  })
}

/**
 * A pick-one value moved onto an option this file offers.
 *
 * Only where the held one is *not* offered, and only onto the first that is —
 * so a reader's own choice is never overwritten, and a descriptor default that
 * this file cannot run does not become a Run that refuses itself. Where nothing
 * is offered the value is left alone: the control shows it disabled and the
 * estimate says why, which is better than inventing an answer.
 */
export function resolveChoiceDefaults(
  specs: readonly ParamSpec[],
  context: AnalysisContext,
  value: Params,
): Params {
  const out: Record<string, ParamValue> = { ...value }
  for (const spec of specs) {
    if (spec.kind !== 'choice') continue
    const offered = optionsFor(spec, context)
    if (offered.length === 0) continue
    const held = stringOr(out[spec.key], spec.default)
    if (offered.some((option) => option.value === held)) continue
    out[spec.key] = offered[0].value
  }
  return out
}

/**
 * What to call an option on this file.
 *
 * "Contig" is right for a metagenome, where a sequence is a fragment of an
 * assembly and calling it a chromosome would be a claim about biology the file
 * does not make. On a cooler every sequence *is* a chromosome, and a reader
 * looking at yeast should not have to translate.
 */
function labelOf(option: ChoiceOption, context: AnalysisContext): string {
  return context.hasGenomes ? option.label : (option.coolLabel ?? option.label)
}

/**
 * How many features are read to discover a feature set's numeric columns.
 *
 * A dropdown is filled while somebody is looking at it, and a million-row GTF
 * must not be walked to do it. Four hundred rows is far more than enough to see
 * every attribute a file writes — the columns of a BED-like format are a
 * property of the *format*, not of the row — and it is a bounded cost on the
 * largest file this app opens.
 */
const DETAIL_SCAN = 400

/** The column every feature set has, whatever else it carries. */
const SCORE_COLUMN = 'score'

/** Distinguishes the ids of two forms mounted at once — the drawer and a test. */
let forms = 0

export interface ParamFormOptions {
  specs: readonly ParamSpec[]
  context: AnalysisContext
  value: Params
  onChange(next: Params): void
  /**
   * Where a {@link FileParam}'s file is kept, by parameter key.
   *
   * The form's own when absent — a test, a host with nothing to run — and the
   * runner's in the drawer, since the form is rebuilt whenever the task changes
   * and the run is where the file is read back (`AnalysisRunner.holdFile`).
   */
  files?: FileShelf
}

/** Somewhere a {@link FileParam}'s file outlives the form it was handed to. */
export interface FileShelf {
  get(key: string): HeldFile | undefined
  set(key: string, held: HeldFile | null): void
}

/** A shelf of the form's own, for a form nobody gave one. */
function ownShelf(): FileShelf {
  const held = new Map<string, HeldFile>()
  return {
    get: (key) => held.get(key),
    set: (key, file) => {
      if (file === null) held.delete(key)
      else held.set(key, file)
    },
  }
}

/** Whether `name` ends in one of a {@link FileParam}'s endings. */
function accepts(spec: FileParam, name: string): boolean {
  const lower = name.toLowerCase()
  return spec.accept.some((ending) => lower.endsWith(ending))
}

// ---------------------------------------------------------------------------
// Resolving what the form points at
// ---------------------------------------------------------------------------

/**
 * The interval kinds, resolved once from the predicate that defines them.
 *
 * Derived rather than listed, so this and {@link isIntervalSet} cannot
 * disagree — which is the whole reason the predicate exists.
 */
const INTERVAL_SETS: readonly AnnotationKind[] = ANNOTATION_KINDS.filter(isIntervalSet)

/** Which annotation kinds one entry parameter may name. */
function kindsFor(spec: EntryParam): readonly AnnotationKind[] {
  switch (spec.kind) {
    // A gene model, a peak set and a variant set are one shape and three
    // meanings (§8.1, §8.14), and a task that wants intervals wants all of
    // them: the distinction is what the reader means by a row, which is their
    // business rather than a task's.
    //
    // Through `isIntervalSet` rather than a list, so this and the availability
    // gates of the tasks that read it cannot answer differently — which they
    // did, leaving a VCF selectable in a form behind a gate that never opened.
    case 'featureSet':
      return INTERVAL_SETS
    case 'pairSet':
      return ['pairs']
    // `track` is deliberately not filtered by card. A synthetic lane is a track
    // (§18.5), so an insulation profile is available to the next task as an
    // ordinary input — which is what makes the composites of §18.2 composable at
    // all rather than a special case each.
    case 'track':
      return ['track']
    case 'sequence':
      return ['sequence']
  }
}

/**
 * The entries one parameter may be set to.
 *
 * An errored row is dropped and a loading one is kept: the first has no data and
 * never will, while the second is a file that is about to arrive and whose
 * absence from the list for two seconds would leave the reader looking for it. A
 * `detached` row stays too — the reader chose that file, and clearing their
 * choice because a reload cannot re-read a dropped file is losing the recipe to
 * protect them from a message.
 */
function candidatesFor(spec: EntryParam, context: AnalysisContext): AnnotationEntry[] {
  const kinds = kindsFor(spec)
  return context.entries.filter(
    (entry) => kinds.includes(entry.kind) && entry.status !== 'error',
  )
}

/**
 * The starred entry, else the first — §18.2's rule, in one place.
 *
 * `null` where nothing of that kind is loaded, which is a form that cannot run
 * rather than a form that is broken; the drawer's estimate says so.
 */
function starredId(candidates: readonly AnnotationEntry[]): string | null {
  const star = candidates.find((entry) => entry.primary === true)
  return (star ?? candidates[0])?.id ?? null
}

function isEntrySpec(spec: ParamSpec): spec is EntryParam {
  return (
    spec.kind === 'featureSet' ||
    spec.kind === 'pairSet' ||
    spec.kind === 'track' ||
    spec.kind === 'sequence'
  )
}

/**
 * One entry choice, repaired against what is loaded now.
 *
 * The whole of this function turns on `null` not being `''`, which is the
 * distinction `defaultParams` is careful to leave behind: **`null` is nobody has
 * resolved this yet** and is filled from the star, while **`''` is a reader who
 * chose the empty option** and is an answer. Without the two being different, an
 * optional parameter set to *none* would be helpfully filled in again on the next
 * context change, and a task would quietly start reading a file nobody asked it
 * to read.
 */
function resolveOne(
  spec: EntryParam,
  context: AnalysisContext,
  held: ParamValue | undefined,
): ParamValue {
  const candidates = candidatesFor(spec, context)
  const named = typeof held === 'string' && held !== ''
  if (named && candidates.some((entry) => entry.id === held)) return held
  if (spec.optional === true) {
    // A named entry that has gone clears to *none* rather than to the star. The
    // parameter was optional, so none is a state the task is built to handle,
    // and silently swapping in a different file would change what the numbers
    // mean without changing anything the reader can see.
    //
    // Filled from what the reader **loaded**, never from what a task made: an
    // optional input is one a task reads if it is there, and another task's
    // output is not a gene model because it is the first interval set on the
    // list — the two loci an origin call leaves behind phased the compartments
    // by default, and said only that the phasing was ambiguous.
    return named || held === '' ? '' : (starredId(readerLoaded(candidates)) ?? '')
  }
  return starredId(candidates)
}

/** What the reader loaded, rather than what a task made — what an optional input is filled from. */
function readerLoaded(candidates: readonly AnnotationEntry[]): AnnotationEntry[] {
  return candidates.filter(
    (entry) => entry.source.kind !== 'computed' && entry.source.kind !== 'derived',
  )
}

/**
 * A multi-select's ids, repaired the same way.
 *
 * Emptied by the repair — or never filled — a *required* list opens on the
 * starred entry, because a required list with nothing in it is a Run that cannot
 * happen and `defaultParams` has no way to name a file.
 *
 * `optional: true` is how a descriptor says that an empty set is a legal answer,
 * and there `null` and `[]` are two answers, as they are for a `sequences` list:
 * **`null` is nobody has chosen yet**, and opens on the star of what the reader
 * loaded — staying unanswered while nothing is, so a track loaded afterwards is
 * ticked the way it would have been at opening — while **`[]` is a reader who
 * unticked every box**, and is kept. The two used to be one value, and the drawer
 * hands the form its context around every run, so APA's track aggregates ticked
 * the starred track back on as Run was pressed with every box unticked.
 */
function resolveMany(
  spec: EntryParam,
  context: AnalysisContext,
  held: ParamValue | undefined,
): readonly string[] | null {
  const candidates = candidatesFor(spec, context)
  const live = new Set(candidates.map((entry) => entry.id))
  const kept = Array.isArray(held)
    ? held.filter((id): id is string => typeof id === 'string' && live.has(id))
    : []
  if (spec.optional === true) {
    // A ticked entry that has gone leaves the list one shorter, never the star
    // in its place: the reader's answer is what was ticked, as in `resolveOne`.
    if (Array.isArray(held)) return kept
    const star = starredId(readerLoaded(candidates))
    return star === null ? null : [star]
  }
  if (kept.length > 0) return kept
  const star = starredId(candidates)
  return star === null ? [] : [star]
}

/**
 * A `key value`, `key=value` or `key: value` pair whose value is a number.
 *
 * All three forms, because this app's own parsers write the first — `signal
 * 12.3`, `-log10 q 4.5`, `summit +120` — and a file that arrived through some
 * other route may well write either of the others. The **value is the last
 * token** rather than the first, which is what keeps `-log10 p 4.5` a column
 * called `-log10 p` instead of one called `-log10`.
 *
 * `4 exons` is rejected, and correctly: its number is on the wrong side, so
 * there is no way to tell it from a unit without knowing what the words mean.
 */
function numericPair(part: string): string | null {
  const marked = /^\s*(.*?)\s*[=:]\s*(\S+)\s*$/.exec(part)
  const spaced = marked ?? /^\s*(.*\S)\s+(\S+)\s*$/.exec(part)
  if (spaced === null) return null
  const key = spaced[1]
  if (key === '' || !Number.isFinite(Number(spaced[2]))) return null
  return key
}

/**
 * The numeric columns of one feature or pair set.
 *
 * `score` is always offered, whether or not the file filled it: it is the column
 * every {@link FeatureSet} has, a task that ranks by it on a file with none gets
 * `NaN`s it can report, and a dropdown that is empty on a plain BED is a control
 * the reader has to guess the meaning of.
 */
function numericColumns(entry: AnnotationEntry | undefined): string[] {
  const out = [SCORE_COLUMN]
  const payload = entry?.payload
  if (payload === undefined) return out
  const detail = payload.data.detail
  const seen = new Set(out)
  const limit = Math.min(detail.length, DETAIL_SCAN)
  for (let i = 0; i < limit; i++) {
    for (const part of detail[i].split(DETAIL_SEP)) {
      const key = numericPair(part)
      if (key === null || seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
  }
  return out
}

/** The entry a `column` parameter's `from` currently names, if any. */
function sourceEntry(
  spec: ColumnParam,
  context: AnalysisContext,
  params: Params,
): AnnotationEntry | undefined {
  const held = params[spec.from]
  // A `from` pointing at a multi-select takes the first of the chosen sets. The
  // union would offer a column that only one of them has, and every feature from
  // the others would score `NaN` against it — which looks like a bug in the task
  // rather than a column that was never there.
  const id = typeof held === 'string' ? held : Array.isArray(held) ? (held[0] ?? '') : ''
  return id === '' ? undefined : context.entries.find((entry) => entry.id === id)
}

function columnsFor(spec: ColumnParam, context: AnalysisContext, params: Params): string[] {
  return numericColumns(sourceEntry(spec, context, params))
}

/**
 * A set of ticked sequences, against the file that is actually open.
 *
 * Two jobs, and the first is the one the convention rests on: **never answered
 * is every sequence**, so a task that takes one of these starts genome-wide
 * rather than starting refused. `null` is what {@link defaultParams} writes and
 * is the only value that means it — an array is the reader's answer, including
 * the empty one they get by pressing **None**, which is left exactly as it is and
 * refused at Run rather than helpfully undone.
 *
 * The second is repair: a name the file does not have is dropped, exactly as a
 * dropped track is dropped from an entry parameter. That is a stored session
 * reopened against another assembly, and a run asking the reader for
 * `chr1` on a file whose sequences are `I`…`XVI` is a run that refuses itself
 * for a reason nothing on screen explains.
 */
function resolveSequences(context: AnalysisContext, held: ParamValue | undefined): string[] {
  const known = context.contigs.map((contig) => contig.name)
  if (!Array.isArray(held)) return known
  const has = new Set(known)
  return held.filter((name): name is string => typeof name === 'string' && has.has(name))
}

/** A column choice, repaired by the same rule the entry choices follow. */
function resolveColumn(
  spec: ColumnParam,
  context: AnalysisContext,
  params: Params,
): ParamValue {
  const columns = columnsFor(spec, context, params)
  const held = params[spec.key]
  const named = typeof held === 'string' && held !== ''
  if (named && columns.includes(held)) return held
  if (spec.optional === true) return named || held === '' ? '' : (columns[0] ?? '')
  return columns[0] ?? null
}

/**
 * Fill every entry parameter the starring rule can fill, and clear every one
 * that names something no longer loaded.
 *
 * Called by the drawer whenever the context changes, so that dropping a track
 * cannot leave a form pointing at it and pressing **Run** cannot ask the worker
 * for an id nothing answers to. Pure, and it touches only the entry and column
 * keys — a number the reader typed passes through untouched, which is what lets
 * the drawer call it on every context change rather than only on the first.
 *
 * Two passes, and they are not interchangeable: a `column` resolves against
 * whichever set its `from` parameter holds *after* that parameter has been
 * repaired, and a descriptor is free to list the two in either order.
 */
export function resolveEntryDefaults(
  specs: readonly ParamSpec[],
  context: AnalysisContext,
  value: Params,
): Params {
  // **Only what this task has parameters for.** The incoming record is a stored
  // session's (`analysis/memory.ts`), and a task's parameters are not fixed for
  // all time: one renamed or retired between builds leaves a value remembered
  // under a key this form has no control for, which would then go on reaching a
  // runner that still reads it. A key with no spec is not a parameter of this
  // task, and is dropped rather than carried; the CLI makes the same judgement
  // louder, by refusing to start.
  //
  // A key whose spec exists but is *hidden on this file* (`needsNoGenomes`) is
  // deliberately not touched here. It is still a parameter of the task, the
  // reader may have set it on another file, and the runner — which is the one
  // that knows what a metagenome makes of it — settles it there rather than
  // depending on this function to have deleted it.
  const known = new Set(specs.map((spec) => spec.key))
  const out: Record<string, ParamValue> = {}
  for (const [key, held] of Object.entries(value)) {
    if (known.has(key)) out[key] = held
  }
  for (const spec of specs) {
    if (!isEntrySpec(spec)) continue
    out[spec.key] =
      spec.multiple === true
        ? resolveMany(spec, context, out[spec.key])
        : resolveOne(spec, context, out[spec.key])
  }
  for (const spec of specs) {
    if (spec.kind === 'column') out[spec.key] = resolveColumn(spec, context, out)
  }
  for (const spec of specs) {
    if (spec.kind === 'sequences') out[spec.key] = resolveSequences(context, out[spec.key])
  }
  // The controls that are not controls: a derived toggle is the file's answer,
  // not the reader's, so it is overwritten on every resolution rather than
  // merely defaulted. A stored session carrying the old tickbox's value lands
  // here too, which is the point — the value that ran is the one this file's
  // weights support, whatever a form somewhere once said.
  for (const spec of specs) {
    if (spec.kind === 'toggle' && spec.derive !== undefined) out[spec.key] = spec.derive(context)
  }
  // And the controls this file is not asked about at all: they keep a value,
  // that value is written into the provenance of the run and into the header of
  // every table exported from it, and a default left sitting there says the run
  // was something it was not. See {@link ParamBase.settled}.
  for (const spec of specs) {
    if (spec.settled === undefined) continue
    if (!paramAsked(spec, context)) out[spec.key] = spec.settled
  }
  // After the entries, because a choice can be filtered by what is loaded and
  // the entry repair above is what decides whether anything is.
  return resolveChoiceDefaults(specs, context, out)
}

// ---------------------------------------------------------------------------
// Small readings of the context
// ---------------------------------------------------------------------------

function numberOr(value: ParamValue | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOr(value: ParamValue | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * The framing as a locus, in the syntax the views' own boxes take.
 *
 * A view showing more than one contig answers with the **name** of the contig it
 * starts on rather than with a span, because a bare name is a whole contig to
 * every box in this app and a span that stops partway through the next sequence
 * is a region nobody meant. `''` where there is no map to read a framing from.
 */
function framingRegion(context: AnalysisContext, many = false): string {
  const framing = context.framing
  if (framing === null) return ''
  // **Only where the axis is made of bins.** A genome × genome picture's
  // extents count *slots* — one per MAG — and read as bins they resolve to a
  // window of whichever sequence the file happens to start with: on a
  // 48-genome overview, `NODE_17248_len_278011:1-48,000`, a locus nobody
  // pointed at, offered as the default anchor of the 4C task and run without a
  // word if the reader pressed the button. There is no honest answer at that
  // level — the picture is of *all* the genomes — so the box stays empty and
  // the task asks for a name, which is what the reader is there to give.
  if (framing.level === 'genome') return ''
  const [from, to] = framing.rows
  const touching = (extent: readonly [number, number]) =>
    context.contigs.filter((item) => item.startBin < extent[1] && item.startBin + item.bins > extent[0])
  if (many) {
    // **What the map shows**, for a box that takes several (§25.6): every
    // sequence either axis touches — a map of chrI against chrIV shows
    // those two and not the chrII between them — and nothing at all, which
    // is every sequence, when that is all of them. One sequence reads as a
    // box that takes one does, below.
    const shown = [...new Set([...touching(framing.rows), ...touching(framing.cols)])]
    if (shown.length === 0 || shown.length === context.contigs.length) return ''
    if (shown.length > 1) {
      return context.contigs
        .filter((item) => shown.includes(item))
        .map((item) => item.name)
        .join(', ')
    }
  }
  const contig = context.contigs.find(
    (item) => from >= item.startBin && from < item.startBin + item.bins,
  )
  if (contig === undefined) return ''
  if (to > contig.startBin + contig.bins) return contig.name
  const start = (from - contig.startBin) * framing.binsize
  const end = Math.min(contig.length, (to - contig.startBin) * framing.binsize)
  // The display form of §26.1 — 1-based and inclusive, grouped — through
  // `formatLocus`, which is the form this box is read in: the run's own
  // boundary takes it back to cooler's grammar (`analysis/job.ts`'s
  // `runnerParams`), so the seed means the bins on screen, not a base past them.
  //
  // **Grouped, though the comma is taken.** §26.1 wants the separators — an
  // analysis form opened with `IV:1000001-1400000` under a line reading
  // `IV:1,000,001-1,400,000 · 1 kb bins` was two spellings of one window in the
  // one place a reader is about to edit the number. A box that takes
  // **several** sequences is comma-separated, which is where this first went
  // wrong: `split(',')` read the seed as `IV:1`, `000`, `001-1` and `400`, and
  // the reconstruction came back *Expected HYPHEN token missing* for a locus
  // copied out of the line above its own box. The list is split by
  // `splitRegionList` now, which knows a thousands comma from a separator, so
  // every one of these boxes reads the way the rest of the application writes.
  return formatLocus({ contig: contig.name, start: Math.max(0, Math.round(start)), end: Math.round(end) })
}

/**
 * The next seed, from this app's own generator rather than from the platform's.
 *
 * `Math.random()` is refused here for the same reason `analysis/random.ts` gives
 * for refusing it inside a task: the seed is the one number a reproducible figure
 * hangs on, and a number nobody can write down is a poor thing to hang it on.
 * Rolling is a *chain* — each press advances mulberry32 once from the seed in the
 * box — so the sequence of seeds a reader walked through is itself replayable
 * from the one they started at.
 */
function rollSeed(from: number): number {
  const next = Math.floor(makeRandom(from)() * 4294967296)
  // A generator that answered with its own input would turn the dice into a
  // button that does nothing, which reads as a broken control rather than as an
  // improbable draw.
  return next === from ? (from + 1) >>> 0 : next
}

function sameValue(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, at) => item === b[at])
  }
  return a === b
}

function sameParams(a: Params, b: Params): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!sameValue(a[key], b[key])) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

/**
 * One rendered parameter.
 *
 * `wrapper` is what `when` adds and removes, and it is kept across a hide so the
 * control inside it — and the state a browser holds for it, a caret position, a
 * scroll offset in a long list — survives being toggled off and on again.
 */
interface Control {
  spec: ParamSpec
  wrapper: HTMLElement
  /** Whether the wrapper is in the document right now. */
  shown: boolean
  /** Put the held value back on screen. */
  sync(): void
  /** Rebuild the options this control offers from the current context. */
  refill?(): void
}

export class ParamForm {
  /** The form itself, for the drawer to parent. */
  readonly el: HTMLElement

  private context: AnalysisContext
  private params: Record<string, ParamValue>
  private readonly specs: readonly ParamSpec[]
  private readonly controls: Control[] = []
  /** Section heading (`''` for the top group) to the element rows live in. */
  private readonly groups = new Map<string, HTMLElement>()
  /** Unsubscribes for the controls that listen to something outside this form. */
  private readonly teardown: Array<() => void> = []
  private readonly id = `pf${forms++}`
  private readonly shelf: FileShelf

  constructor(private readonly options: ParamFormOptions) {
    this.specs = options.specs
    this.context = options.context
    this.shelf = options.files ?? ownShelf()
    this.params = { ...resolveEntryDefaults(options.specs, options.context, options.value) }
    this.fillRegions()
    this.forgetUnheld()

    this.el = el('div', { class: 'param-form' })
    for (const section of this.sections()) this.el.appendChild(this.group(section))
    for (const spec of this.specs) {
      // A derived parameter has no control at all — not a disabled one and not a
      // hidden one. It is the file's answer rather than a question, and a
      // greyed-out tickbox saying "balanced, and you may not change it" is a
      // control whose whole content is an apology.
      if (paramDerived(spec)) continue
      const control = this.build(spec)
      this.controls.push(control)
      this.groups.get(spec.section ?? '')?.appendChild(control.wrapper)
      control.shown = true
    }
    // No `onChange` from the constructor. The caller handed the value in and can
    // read `value` back for whatever the resolution changed; firing an event at
    // a listener that is still being wired up is how a drawer ends up estimating
    // a cost for a task it has not finished mounting.
    this.syncVisibility()
  }

  /** Everything the form holds, hidden controls included. */
  get value(): Params {
    return { ...this.params }
  }

  /**
   * Adopt a different file's context.
   *
   * Entry dropdowns are refilled and repaired **in place**: the numbers, the
   * choices and the toggles are the reader's answer to a question that has not
   * changed, and a form that reset itself because a track was dropped would make
   * changing the tracks something a reader learns not to do mid-configuration.
   * Fires `onChange` only when the repair actually moved something, since the
   * drawer re-prices the run on every one.
   */
  setContext(context: AnalysisContext): void {
    this.context = context
    const before: Params = { ...this.params }
    this.params = { ...resolveEntryDefaults(this.specs, context, this.params) }
    this.fillRegions()
    for (const control of this.controls) {
      control.refill?.()
      control.sync()
    }
    this.syncVisibility()
    if (!sameParams(before, this.params)) this.options.onChange(this.value)
  }

  /**
   * Show a different parameter set — what recalling a remembered one does.
   *
   * Silent, because the caller is the one that already knows: this is the drawer
   * telling the form what the value is, not the reader changing it.
   */
  setValue(value: Params): void {
    this.params = { ...resolveEntryDefaults(this.specs, this.context, value) }
    this.fillRegions()
    this.forgetUnheld()
    for (const control of this.controls) {
      control.refill?.()
      control.sync()
    }
    this.syncVisibility()
  }

  /**
   * Take the form down.
   *
   * Almost every listener here is on a node this class owns, so detaching the
   * root would be most of it — {@link teardown} is for the ones that are not.
   * The locus control that follows the map subscribes to a module-level
   * singleton, and a form left subscribed after its drawer closed would go on
   * committing anchors into a task nobody is looking at.
   */
  destroy(): void {
    for (const stop of this.teardown) stop()
    this.teardown.length = 0
    this.el.remove()
    this.controls.length = 0
    this.groups.clear()
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  /**
   * The section headings, in the order they are drawn.
   *
   * `''` first and always, because §18.2's rule about headings is that the
   * parameters somebody actually changes live above every one of them — a task
   * whose first control is behind a heading has its headings wrong. The rest
   * follow in the order the descriptor first mentions them, so the file is the
   * document.
   */
  private sections(): string[] {
    // Derived specs are not counted, or a section whose only member is one would
    // be an empty card with a heading over it.
    const shown = this.specs.filter((spec) => !paramDerived(spec))
    const out = ['']
    for (const spec of shown) {
      const section = spec.section ?? ''
      if (!out.includes(section)) out.push(section)
    }
    return out.filter((section) => shown.some((spec) => (spec.section ?? '') === section))
  }

  /** One card per section, which is the shape the three panels' cards have. */
  private group(section: string): HTMLElement {
    const rows = el('div', { class: 'panel-controls' })
    this.groups.set(section, rows)
    return el(
      'div',
      { class: 'controls-card param-group' },
      section === '' ? null : el('h3', { class: 'controls-title', text: section }),
      rows,
    )
  }

  /**
   * A control, its label and its one line of small print.
   *
   * The hint sits outside the `<label>` rather than inside it: it is a sentence
   * about the parameter, and a screen reader that read it as part of the field's
   * name would announce a paragraph every time the caret entered the box.
   */
  private wrap(spec: ParamSpec, field: HTMLElement, status?: HTMLElement): HTMLElement {
    return el(
      'div',
      { class: 'param-row' },
      field,
      // Above the descriptor's hint, because it is about *now* — whether an
      // anchor has been picked yet — and the hint is about the parameter always.
      status,
      spec.hint === undefined ? null : el('div', { class: 'hint', text: spec.hint }),
    )
  }

  /** The two-column row: a word, then one control. */
  private labelled(spec: ParamSpec, control: HTMLElement, id: string): HTMLElement {
    return el(
      'label',
      { class: 'field param-field', attrs: { for: id } },
      el('span', { class: 'field-label', text: spec.label }),
      control,
    )
  }

  /**
   * The two-column row for a control a `<label for>` cannot name.
   *
   * A `<button>` is not a labelable element, so the same shape has to be built
   * out of a `<div>` and an id'd word the control points back at with
   * `aria-labelledby`. Same grid, same alignment as every `labelled` row beside
   * it — which is the point: a reader's eye should find the control in one place
   * down the form, whatever kind of control it is.
   */
  private named(spec: ParamSpec, control: HTMLElement, labelId: string): HTMLElement {
    return el(
      'div',
      { class: 'field param-field' },
      el('span', { class: 'field-label', text: spec.label, id: labelId }),
      control,
    )
  }

  /**
   * The full-width row: a word above a *group* of controls.
   *
   * What the overlay marks already use, and for the same reason — four buttons
   * squeezed into a 7 rem value column wrap one per line and leave the word
   * floating against a stack.
   */
  private blocked(spec: ParamSpec, group: HTMLElement, labelId: string): HTMLElement {
    group.setAttribute('role', 'group')
    group.setAttribute('aria-labelledby', labelId)
    return el(
      'div',
      { class: 'field field-block param-field' },
      el('span', { class: 'field-label', text: spec.label, id: labelId }),
      group,
    )
  }

  // -------------------------------------------------------------------------
  // Committing
  // -------------------------------------------------------------------------

  /**
   * One edit, complete. Nothing else in this module writes `params`.
   *
   * **Every control is re-synced, not just the one that changed**, and the
   * omission of that line is worth a comment because of how it failed. A native
   * `<input>` shows what was typed into it without being told, so the number and
   * text fields looked fine; a *button* shows its state through `aria-pressed`,
   * which only `sync()` sets — so every toggle and every segmented choice in
   * every task read as stuck on its default, however many times it was clicked.
   * The value underneath was changing the whole time, which is what made it look
   * like a dead control rather than a broken one.
   *
   * Syncing all of them rather than one also covers the case that made this
   * worth doing properly: a `when` clause can make one parameter's value change
   * what another one *is*, and a control that repaints only itself cannot show
   * that.
   */
  private commit(key: string, value: ParamValue): void {
    if (sameValue(this.params[key], value)) return
    this.params[key] = value
    for (const control of this.controls) {
      if (control.spec.kind === 'column') control.refill?.()
      control.sync()
    }
    this.syncVisibility()
    this.options.onChange(this.value)
  }

  /**
   * Add and remove the wrappers `when` decides about.
   *
   * Walked backwards so each control knows the first *visible* wrapper after it
   * and can be inserted before that one, which is what keeps the descriptor's
   * order after a control in the middle has come back. Nothing already in the
   * right place is touched: re-appending a node that holds the caret is a blur,
   * and a form that blurred its own box on every keystroke's commit would be
   * unusable.
   */
  private syncVisibility(): void {
    const after = new Map<string, HTMLElement | null>()
    for (let i = this.controls.length - 1; i >= 0; i--) {
      const control = this.controls[i]
      const section = control.spec.section ?? ''
      const rows = this.groups.get(section)
      if (rows === undefined) continue
      const shown = paramVisible(control.spec, this.params, this.context)
      const ref = after.get(section) ?? null
      if (shown && !control.shown) rows.insertBefore(control.wrapper, ref)
      else if (!shown && control.shown) control.wrapper.remove()
      control.shown = shown
      if (shown) after.set(section, control.wrapper)
    }
    // A card none of whose controls is shown is not drawn either: a heading over
    // nothing is a question the form has decided not to ask, still taking a line
    // to say so — APA's Control card under observed / expected, say.
    for (const [section, rows] of this.groups) {
      rows.parentElement?.classList.toggle('hidden', !after.has(section))
    }
  }

  /**
   * Give every empty region box the framing.
   *
   * Only the empty ones. A locus the reader typed is an answer, and re-deriving
   * it from the view every time the context changes would make the box impossible
   * to hold still while panning to check something.
   */
  private fillRegions(): void {
    for (const spec of this.specs) {
      if (spec.kind !== 'region') continue
      if (stringOr(this.params[spec.key], '') !== '') continue
      const region = spec.default ?? framingRegion(this.context, spec.many === true)
      if (region !== '') this.params[spec.key] = region
    }
  }

  /**
   * Empty a file parameter whose file is not held any more.
   *
   * A local file's value is its name ({@link FileParam}), and a name outlives
   * the file: a form recalled after a reload holds one with nothing behind it,
   * and a run would reach the worker with a name no browser can open and come
   * back with a sentence about addresses. Emptied, the drop area asks again.
   * An address is its own value and is kept.
   *
   * Only where a value arrives — built, or recalled — and not on a change of
   * context, which is every pan: nothing a reader has handed the form goes
   * missing while they look at the map.
   */
  private forgetUnheld(): void {
    for (const spec of this.specs) {
      if (spec.kind !== 'file') continue
      const value = stringOr(this.params[spec.key], '').trim()
      if (value === '' || isAddress(value)) continue
      if (this.shelf.get(spec.key)?.value === value) continue
      this.params[spec.key] = ''
    }
  }

  // -------------------------------------------------------------------------
  // The seven kinds
  // -------------------------------------------------------------------------

  private build(spec: ParamSpec): Control {
    switch (spec.kind) {
      case 'number':
        return this.numberControl(spec)
      case 'choice':
        return this.choiceControl(spec)
      case 'toggle':
        return this.toggleControl(spec)
      case 'featureSet':
      case 'pairSet':
      case 'track':
      case 'sequence':
        return spec.multiple === true ? this.entryList(spec) : this.entrySelect(spec)
      case 'column':
        return this.columnControl(spec)
      case 'sequences':
        return this.sequenceList(spec)
      case 'region':
        return this.locusControl(spec)
      case 'text':
        return this.textControl(spec)
      case 'file':
        return this.fileControl(spec)
      case 'seed':
        return this.seedControl(spec)
    }
  }

  /**
   * A number, with a slider beside it where the range is one somebody sweeps.
   *
   * The bounds are applied on `change` and on Enter, and on nothing else. A box
   * that clamped per keystroke would answer a floor of 2 by rewriting the `1` of
   * `10` before the `0` was typed, and the reader would conclude that 10 is not
   * allowed. An unreadable box is put back rather than obeyed, for the reason
   * `stepperField` gives: `Number('')` is 0, and 0 is not what an emptied field
   * means.
   */
  private numberControl(spec: NumberParam): Control {
    const id = `${this.id}-${spec.key}`
    const bounded = spec.min !== undefined && spec.max !== undefined
    const withSlider = spec.slider === true && bounded
    const step = spec.step ?? (spec.integer === true ? 1 : undefined)

    const box = el('input', {
      // `input-step` is the box that shares a row with something else: it keeps
      // its own width instead of the 100% a lone number box takes, which would
      // push the slider onto a line of its own.
      class: withSlider ? 'input input-num input-step' : 'input input-num',
      type: 'number',
      // Without a size an `<input type=number>` asks for about twenty
      // characters' worth of room as a *minimum*, and one of them widens every
      // row beside it past the card.
      attrs: { id, size: '1', step: step === undefined ? 'any' : String(step) },
    })
    if (spec.min !== undefined) box.min = String(spec.min)
    if (spec.max !== undefined) box.max = String(spec.max)

    const slider = withSlider
      ? el('input', { class: 'ann-range', type: 'range' })
      : null
    if (slider !== null && spec.min !== undefined && spec.max !== undefined) {
      slider.min = String(spec.min)
      slider.max = String(spec.max)
      slider.step = String(step ?? (spec.max - spec.min) / 100)
      slider.setAttribute('aria-labelledby', `${id}-label`)
    }

    const clamp = (raw: number): number => {
      let value = spec.integer === true ? Math.round(raw) : raw
      if (spec.min !== undefined) value = Math.max(spec.min, value)
      if (spec.max !== undefined) value = Math.min(spec.max, value)
      return value
    }
    // An unanswered seeded number shows what it stands for on this context —
    // the open map's resolution, say — and follows it until the reader types.
    const held = (): number =>
      numberOr(this.params[spec.key], spec.seed?.(this.context) ?? spec.default)
    // A seed the context has no answer for — a kernel at a resolution that has
    // none of its own — is an empty box for the reader to fill, not `NaN`; the
    // estimate refuses the run until it is filled and says why.
    const show = (value: number): void => {
      box.value = Number.isFinite(value) ? String(value) : ''
      if (slider !== null && Number.isFinite(value)) slider.value = String(value)
    }
    const commitBox = (): void => {
      // On the *string*, not on `Number(box.value)`: `Number('')` is 0 and 0 is
      // finite, so this guard never fired and an emptied box committed
      // `clamp(0)` — the parameter's minimum — as though the reader had typed
      // it. A `type="number"` box reports an empty string for a cleared box and
      // for everything it could not parse alike (`1e`, `--`, a pasted word), so
      // both now put the held value back. Same form as `ui/ClipRange.ts` and
      // `ui/trackControls.ts`, which learnt it the same way.
      const raw = box.value.trim()
      const typed = raw === '' ? Number.NaN : Number(raw)
      if (!Number.isFinite(typed)) {
        show(held())
        return
      }
      const value = clamp(typed)
      show(value)
      this.commit(spec.key, value)
    }

    box.addEventListener('change', commitBox)
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commitBox()
    })
    if (slider !== null) {
      slider.addEventListener('input', () => {
        box.value = String(clamp(Number(slider.value)))
      })
      // On `change` and not on `input`: a drag across a two-hundred-pixel track
      // is two hundred commits, which is two hundred cost estimates for one
      // decision the reader has not made yet.
      slider.addEventListener('change', () => this.commit(spec.key, clamp(Number(slider.value))))
    }

    // **The unit beside the box is the whole of what says what the number is**,
    // and it is written beside it rather than folded into the label because it
    // belongs to the number: `%` is drawn with its sign, and `bins` says a count
    // of the file's own cells. A count of *diagonals* says so in its label
    // instead — *diagonals*, *diagonals to ignore* — because there the word is
    // the question rather than a unit hung off a number.
    //
    // There used to be a caption under every `bp` box reading *n bins at 1 kb*,
    // translating what the reader typed into what the task would do. It is gone
    // with the boxes it was for: a matrix parameter is asked in bins now
    // (§18.2), so there is nothing left to translate, and on the boxes that do
    // still take base pairs — a metaplot's flank, a FRiP's sampling step — it
    // was measuring a 1D quantity against a matrix's resolution and reading
    // `1 bin at 10.0 kb` beside a box saying `10,000`.
    const unit =
      spec.unit === undefined || spec.unit === ''
        ? null
        : el('span', { class: 'field-label', text: spec.unit })
    const row = el('div', { class: 'plot-icon-row' }, box, unit, slider)
    // A group carries the word for its members, and a `<label for>` names one
    // control. With a slider there are two of them, so the word is a heading and
    // both boxes point back at it; without one, the ordinary two-column row and
    // its `for` do the same job with no extra attributes.
    if (withSlider) box.setAttribute('aria-labelledby', `${id}-label`)
    const field = withSlider
      ? this.blocked(spec, row, `${id}-label`)
      : this.labelled(spec, row, id)

    const sync = (): void => {
      if (document.activeElement === box) return
      show(held())
    }
    sync()
    return { spec, wrapper: this.wrap(spec, field), shown: false, sync }
  }

  /**
   * A choice: one dropdown, always.
   *
   * It was a row of segmented buttons at four options or fewer, on the argument
   * that "this one is in force" should be the accent border a reader has already
   * learned from the overlay toggles. Two things were wrong with that. The
   * border was the *only* mark, so a reader who could not see the accent colour
   * could not see the answer at all — and a row of four buttons in a 6.5 rem
   * label grid wraps to two lines and then reads as four independent toggles
   * rather than as one question. A `<select>` says "pick one of these" in a
   * shape every reader already knows, shows the answer as a word, and is one
   * line whatever the options are.
   *
   * The options themselves come from {@link optionsFor}, which is where a plain
   * cooler stops being offered "Genome".
   */
  private choiceControl(spec: ChoiceParam): Control {
    const id = `${this.id}-${spec.key}`
    const held = (): string => stringOr(this.params[spec.key], spec.default)
    const select = el('select', { class: 'select', attrs: { id } })

    const refill = (): void => {
      const options = optionsFor(spec, this.context)
      select.replaceChildren()
      for (const option of options) {
        select.appendChild(
          el('option', {
            value: option.value,
            text: labelOf(option, this.context),
            ...(option.hint === undefined ? {} : { title: option.hint }),
          }),
        )
      }
      // A stored session can name an option this file does not offer — a
      // `scope: 'genome'` written against a metacool and reopened on a cooler.
      // Kept as a disabled row rather than silently rewritten, so the form shows
      // what the run will actually be and the estimate can refuse it by name.
      const value = held()
      if (!options.some((option) => option.value === value)) {
        select.appendChild(
          el('option', {
            value,
            text: `${value} — not available on this file`,
            attrs: { disabled: '' },
          }),
        )
      }
    }

    select.addEventListener('change', () => this.commit(spec.key, select.value))
    const sync = (): void => {
      select.value = held()
    }
    refill()
    sync()
    return {
      spec,
      wrapper: this.wrap(spec, this.labelled(spec, select, id)),
      shown: false,
      sync,
      refill,
    }
  }

  /**
   * A boolean, as the mark button whose border appears when it is on.
   *
   * A button rather than a checkbox for the same reason the lane's flip control
   * is one: this is a state of the picture, it is read at a glance across a
   * column of them, and a tick box in a 6.5 rem label grid is eleven pixels of
   * signal in a row of words.
   */
  private toggleControl(spec: ToggleParam): Control {
    const labelId = `${this.id}-${spec.key}-label`
    const node = el('button', {
      class: 'btn btn-toggle',
      type: 'button',
      text: 'on',
      title: spec.hint ?? spec.label,
    })
    // Labelled by the word beside it rather than by an `aria-label` of its own:
    // the button reads "on", and a name that does not contain the visible text
    // is a name nobody can speak to a voice control.
    node.setAttribute('aria-labelledby', labelId)
    node.addEventListener('click', () => {
      const now = this.params[spec.key]
      this.commit(spec.key, !(typeof now === 'boolean' ? now : spec.default))
    })
    const sync = (): void => {
      const on = typeof this.params[spec.key] === 'boolean' ? this.params[spec.key] : spec.default
      node.setAttribute('aria-pressed', String(on))
      // The word changes with the state as well as the colour. A button reading
      // "on" while it is off relies entirely on a border colour to say so, which
      // is the one channel a reader with a colour deficiency does not have — and
      // which nobody reads on a form of twelve of them anyway.
      node.textContent = on === true ? 'on' : 'off'
    }
    sync()
    return {
      spec,
      // **`labelled`, because one button is not a group.** It was `blocked`, the
      // full-width shape the overlay marks use — which put the word on one line
      // and a lone `on` pill on the next, with the hint beside the *label* since
      // that is what the row's first column then held. The reader read label and
      // hint as a sentence about the parameter and had nothing to connect the
      // detached pill to. `blocked` is for a real group: a checklist, a box with
      // a slider beside it, four marks in a row.
      // In a `plot-icon-row`, because a grid cell stretches what is put in it
      // and an `on` button as wide as a 15 rem control column is a button whose
      // size says something it does not mean. The row is one flex item wide and
      // starts where every other control on the form starts.
      wrapper: this.wrap(
        spec,
        this.named(spec, el('div', { class: 'plot-icon-row' }, node), labelId),
      ),
      shown: false,
      sync,
    }
  }

  /** One of what is loaded, defaulting to the starred one (§18.2). */
  private entrySelect(spec: EntryParam): Control {
    const id = `${this.id}-${spec.key}`
    const select = el('select', { class: 'select', attrs: { id } })
    const refill = (): void => {
      const candidates = candidatesFor(spec, this.context)
      select.replaceChildren()
      if (spec.optional === true) {
        select.appendChild(el('option', { value: '', text: spec.noneLabel ?? 'none' }))
      }
      for (const entry of candidates) {
        select.appendChild(el('option', { value: entry.id, text: entry.label }))
      }
      // An empty dropdown with no explanation reads as a control that is broken.
      // This one says what is missing, and the drawer's estimate refuses the run.
      if (candidates.length === 0 && spec.optional !== true) {
        select.appendChild(el('option', { value: '', text: 'nothing loaded' }))
      }
      select.disabled = candidates.length === 0
    }
    select.addEventListener('change', () =>
      this.commit(spec.key, select.value === '' ? (spec.optional === true ? '' : null) : select.value),
    )
    const sync = (): void => {
      select.value = stringOr(this.params[spec.key], '')
    }
    refill()
    sync()
    return {
      spec,
      wrapper: this.wrap(spec, this.labelled(spec, select, id)),
      shown: false,
      sync,
      refill,
    }
  }

  /**
   * Several of what is loaded, as a list of tick boxes.
   *
   * The value is written in the **candidates'** order rather than in the order
   * they were ticked, so a metaplot's series come out in the order the reader
   * sees them stacked on the Annotations panel — clicking the third one first
   * should not reorder a legend.
   */
  private entryList(spec: EntryParam): Control {
    const labelId = `${this.id}-${spec.key}-label`
    const list = el('div', { class: 'ann-list param-checks' })
    let boxes: Array<{ id: string; input: HTMLInputElement }> = []

    const chosen = (): string[] => {
      const held = this.params[spec.key]
      return Array.isArray(held) ? held.filter((item): item is string => typeof item === 'string') : []
    }
    const refill = (): void => {
      const candidates = candidatesFor(spec, this.context)
      list.replaceChildren()
      boxes = candidates.map((entry) => {
        const input = el('input', { class: 'checkbox', type: 'checkbox' })
        input.addEventListener('change', () =>
          this.commit(
            spec.key,
            boxes.filter((box) => box.input.checked).map((box) => box.id),
          ),
        )
        list.appendChild(
          el('label', { class: 'ann-head param-check' }, input, el('span', { text: entry.label })),
        )
        return { id: entry.id, input }
      })
      if (candidates.length === 0) {
        list.appendChild(el('div', { class: 'hint', text: 'nothing loaded' }))
      }
    }
    const sync = (): void => {
      const held = new Set(chosen())
      for (const box of boxes) box.input.checked = held.has(box.id)
    }
    refill()
    sync()
    return {
      spec,
      wrapper: this.wrap(spec, this.blocked(spec, list, labelId)),
      shown: false,
      sync,
      refill,
    }
  }

  /**
   * Several sequences, ticked — with **All** and **None** beside the count.
   *
   * A list of tick boxes rather than a multiple `<select>`, for the reason the
   * Sequences card in the General column gives: a `<select multiple>` needs a
   * modifier to add to a selection and loses the lot to a stray click, which is a
   * control that punishes the gesture it is there for. Ticks are what the rest of
   * this application uses for choosing several of something.
   *
   * The two quick buttons are not a nicety. The two states a reader reaches for
   * are *all of them* and *one of them*, and getting from one to the other by
   * hand on a sixteen-chromosome yeast is sixteen clicks in the wrong direction —
   * so **None** followed by one tick is the second, and **All** is the way back.
   * The line beside them says how many of how many, because a list scrolled past
   * its own bottom cannot be counted by eye.
   */
  private sequenceList(spec: SequencesParam): Control {
    const labelId = `${this.id}-${spec.key}-label`
    const list = el('div', { class: 'ann-list param-checks param-sequences' })
    const count = el('span', { class: 'hint param-check-count' })
    let boxes: Array<{ name: string; input: HTMLInputElement }> = []

    const chosen = (): string[] => {
      const held = this.params[spec.key]
      return Array.isArray(held)
        ? held.filter((item): item is string => typeof item === 'string')
        : []
    }
    const commitTicked = (): void => {
      this.commit(
        spec.key,
        boxes.filter((box) => box.input.checked).map((box) => box.name),
      )
    }
    const refill = (): void => {
      list.replaceChildren()
      boxes = this.context.contigs.map((contig) => {
        const input = el('input', { class: 'checkbox', type: 'checkbox' })
        input.addEventListener('change', commitTicked)
        list.appendChild(
          el(
            'label',
            { class: 'ann-head param-check' },
            input,
            el('span', { text: contig.name }),
            el('span', { class: 'hint param-check-note', text: fmt.bp(contig.length) }),
          ),
        )
        return { name: contig.name, input }
      })
      if (boxes.length === 0) {
        list.appendChild(el('div', { class: 'hint', text: 'this file has no sequences' }))
      }
    }
    const sync = (): void => {
      const held = new Set(chosen())
      for (const box of boxes) box.input.checked = held.has(box.name)
      count.textContent =
        boxes.length === 0
          ? ''
          : `${fmt.int(held.size)} of ${fmt.int(boxes.length)} ticked`
    }

    const quick = el(
      'div',
      { class: 'param-check-actions' },
      button(
        'all',
        () => this.commit(spec.key, this.context.contigs.map((contig) => contig.name)),
        { class: 'btn btn-quiet', title: 'Tick every sequence' },
      ),
      button('none', () => this.commit(spec.key, []), {
        class: 'btn btn-quiet',
        title: 'Untick every sequence',
      }),
      count,
    )

    refill()
    sync()
    return {
      spec,
      wrapper: this.wrap(spec, this.blocked(spec, el('div', {}, quick, list), labelId)),
      shown: false,
      sync,
      refill: () => {
        refill()
        sync()
      },
    }
  }

  /**
   * A numeric column of whichever set the parameter above it names.
   *
   * Refilled from {@link ParamForm.commit} on every edit, which is the whole
   * point of the kind existing: picking a different peak file and being left with
   * the previous file's column names is a form that quietly ranks by a column
   * that is not there.
   */
  private columnControl(spec: ColumnParam): Control {
    const id = `${this.id}-${spec.key}`
    const select = el('select', { class: 'select', attrs: { id } })
    let last: string | null = null

    const refill = (): void => {
      const source = sourceEntry(spec, this.context, this.params)
      // The feature count is in the key as well as the id, so a set that was
      // still parsing when the form was built refills the moment its rows
      // arrive. Without it a dropdown opened one frame too early would offer
      // `score` alone for as long as the drawer stayed up.
      const key = `${source?.id ?? ''}:${source?.payload?.data.length ?? 0}`
      // The scan is bounded but not free, and the source moves far less often
      // than the form does — a slider drag would otherwise re-read four hundred
      // detail strings per commit for a list that cannot have changed.
      if (key === last) return
      last = key
      const columns = numericColumns(source)
      select.replaceChildren()
      if (spec.optional === true) {
        select.appendChild(el('option', { value: '', text: spec.noneLabel ?? 'none' }))
      }
      for (const column of columns) {
        select.appendChild(el('option', { value: column, text: column }))
      }
      // Written straight into `params` rather than through `commit`, because
      // every path that reaches a *stale* column here is already inside one: the
      // edit that moved the set above will carry the repaired column out in the
      // same `onChange`, and calling `commit` from within `commit` would report
      // one edit twice.
      this.params[spec.key] = resolveColumn(spec, this.context, this.params)
      select.value = stringOr(this.params[spec.key], '')
    }
    select.addEventListener('change', () =>
      this.commit(spec.key, select.value === '' ? (spec.optional === true ? '' : null) : select.value),
    )
    const sync = (): void => {
      select.value = stringOr(this.params[spec.key], '')
    }
    refill()
    sync()
    return {
      spec,
      wrapper: this.wrap(spec, this.labelled(spec, select, id)),
      shown: false,
      sync,
      refill,
    }
  }

  /**
   * A locus: a box, with the file's sequences offered beside it — and, where the
   * descriptor says so, a button that takes one off the map.
   *
   * The box stays because a span is the point: an anchor is a window, and a
   * dropdown of sequence names could not express one. The `<datalist>` turns the
   * common case back into a pick — type nothing and the sequences are there, pick
   * one and then add `:500,000-510,000` if that is what was meant.
   *
   * **{@link RegionParam.pickable} is the interesting half.** Shift-drag on the
   * map names a stretch of one axis; ordinarily that zooms, and while this
   * button is lit it fills this box instead. An *arm* rather than a mode the
   * form leaves on: the button lights, the next drag answers it, and it goes
   * out — so a reader who wanted one anchor does not find their next three
   * attempts to zoom quietly redefining it.
   *
   * What is written into the parameter is the **resolved locus**, never a
   * sentinel, so a result's record names the place rather than the gesture — and
   * the box stays editable throughout, because a picked locus is a starting
   * point for a typed correction rather than a replacement for one.
   */
  private locusControl(spec: RegionParam): Control {
    const id = `${this.id}-${spec.key}`
    const listId = `${id}-sequences`
    const options = el('datalist', { attrs: { id: listId } })
    const box = el('input', {
      class: 'input input-region param-region',
      type: 'text',
      attrs: { id, list: listId },
      placeholder: framingRegion(this.context),
      // The sentence every other locus box carries (§26.1), because this box is
      // now read as they are. It used to say *as metacooler show --range takes
      // it*, which was true and was the one place a reader had to know which of
      // two bases a box was in.
      title: devFeature('metacool')
        ? 'A contig, or a contig and a span. Coordinates are 1-based and inclusive, as IGV and ' +
          'samtools write them. On a metagenome a genome name is one too, and means the whole of it.'
        : // A genome name is the multi-genome format's, a dev feature (§29).
          'A sequence, or a sequence and a span. Coordinates are 1-based and inclusive, as IGV and ' +
          'samtools write them.',
    })
    const note = el('p', { class: 'hint param-map-note hidden' })

    // Offered only where there is a map to point at: on a tracks-only session
    // the gesture has no surface, and a button that cannot be answered is worse
    // than no button.
    const pickable = spec.pickable === true && this.context.hasMap
    const arm = !pickable
      ? null
      : button('pick on map', () => (isArmed() ? disarmPick() : armPick()), {
          class: 'btn btn-toggle param-pick',
          title:
            'Then Shift-drag along either axis of the map. That gesture normally zooms; while ' +
            'this is lit it names this locus instead, once.',
        })

    const refill = (): void => {
      // **Genomes first, where the file has them.** A locus box on a metagenome
      // takes either — the range grammar has always resolved a bare genome name
      // (§5.5), and the 4C task means the whole MAG by one — and a list of
      // twenty thousand contigs with no MAG in it taught the reader the
      // opposite. They lead because there are tens of them against tens of
      // thousands, so a list that opened on the contigs would bury them.
      options.replaceChildren(
        ...(this.context.genomes ?? []).map((genome) => el('option', { value: genome.name })),
        ...this.context.contigs.map((contig) => el('option', { value: contig.name })),
      )
    }
    const commit = (): void => this.commit(spec.key, box.value.trim())
    box.addEventListener('change', commit)
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit()
    })

    const sync = (): void => {
      if (arm !== null) {
        const armed = isArmed()
        arm.setAttribute('aria-pressed', String(armed))
        // *pointing…* and not the Manual card's *done*, because the two are
        // genuinely different modes: this arm ends itself after one pick, and
        // that card's stays on until the reader says so. What the two share is
        // the resting label and the lit look, which is what a reader carries
        // from one surface to the other.
        arm.textContent = armed ? 'pointing…' : 'pick on map'
        note.classList.toggle('hidden', !armed)
        note.textContent = armed
          ? 'Shift-drag along either axis of the map. Escape to stop.'
          : ''
      }
      if (document.activeElement === box) return
      box.value = stringOr(this.params[spec.key], '')
    }

    // Written into the parameter rather than held as form state, so a *record*
    // of the run names the locus. The runner never learns a map was involved,
    // which is what keeps an anchor one concept rather than two.
    if (pickable) {
      let seen = lastPick()
      this.teardown.push(
        subscribePick(() => {
          const at = lastPick()
          // Only a *new* pick writes. Arming and disarming announce on the same
          // channel, and a disarm that re-committed the last locus would undo a
          // correction the reader had just typed over it.
          if (at !== null && at !== seen) {
            seen = at
            // **The display form, which is what the box is read in** (§26.1):
            // `IV:1,000,001-1,400,000` for the bins that were dragged, as the
            // seed above writes the framing and as a reader would type it, and
            // the run's own boundary (`runnerParams`) takes it back to exactly
            // those bins. It wrote the machine form while the runners read this
            // box as cooler does — right for them, and the one locus on the form
            // a base off from every other box in the app. A whole unit is its
            // name, which has no base to be off by.
            this.commit(spec.key, at.whole === true ? at.contig : formatLocus(at))
          }
          sync()
        }),
      )
    }

    refill()
    sync()
    return {
      spec,
      wrapper: this.wrap(
        spec,
        this.labelled(
          spec,
          el('div', { class: 'param-locus' }, box, options, ...(arm === null ? [] : [arm])),
          id,
        ),
        note,
      ),
      shown: false,
      sync,
      refill: () => {
        refill()
        sync()
      },
    }
  }

  /**
   * A file the task reads: a drop area that is also a button, and an address
   * box under it (§18.8).
   *
   * **The drop area is the Tracks card's**, `.ann-drop`, so asking for a file
   * looks the same wherever a file is asked for, and pressing it opens the
   * picker the landing page opens (`chooseFiles`). It takes a row dragged out of
   * the Files column as well as a file off the desktop — the same gesture with
   * the bytes somewhere else — and it takes the drop **for itself**: a `.pairs`
   * let through to the app would be *opened*, as a map, behind a dialog, which
   * is the opposite of what was asked.
   *
   * The address box is for a file nobody has on their disk. A local file and an
   * address are one answer, so each replaces the other; a word typed that is
   * not an address is refused under the box rather than committed, since no
   * browser can open a bare name and the run would say so only afterwards.
   */
  private fileControl(spec: FileParam): Control {
    const labelId = `${this.id}-${spec.key}-label`
    const addressId = `${this.id}-${spec.key}`
    const title = el('span', { class: 'ann-drop-label' })
    const detail = el('span', { class: 'ann-drop-hint' })
    const zone = el(
      'div',
      {
        class: 'ann-drop param-drop',
        attrs: { tabindex: '0', role: 'button', 'aria-labelledby': labelId },
      },
      title,
      detail,
    )
    const forget = iconButton('x', 'Forget this file', () => this.chooseFile(spec, null), {
      class: 'btn btn-icon param-drop-forget',
    })
    const address = el('input', {
      class: 'input param-address',
      type: 'text',
      attrs: { id: addressId, 'aria-label': `${spec.label}: address` },
      ...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder }),
    })
    const status = el('p', { class: 'hint param-file-note hidden' })
    const say = (text: string): void => {
      status.textContent = text
      status.classList.toggle('hidden', text === '')
    }

    const take = (file: File): void => {
      if (!accepts(spec, file.name)) {
        say(`${file.name} is not a ${spec.accept.join(' or ')} file.`)
        return
      }
      say('')
      this.chooseFile(spec, {
        value: file.name,
        source: { kind: 'local', file },
        size: file.size,
      })
    }
    const pick = (): void => {
      void chooseFiles({ multiple: false }).then((files) => {
        if (files.length > 0) take(files[0])
      })
    }
    zone.addEventListener('click', pick)
    zone.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      pick()
    })
    zone.addEventListener('dragover', (event) => {
      if (!dragHasFiles(event) && !dragHasFileRow(event)) return
      event.preventDefault()
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', (event) => {
      if (event.relatedTarget instanceof Node && zone.contains(event.relatedTarget)) return
      zone.classList.remove('over')
    })
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      event.stopPropagation()
      zone.classList.remove('over')
      if (dragHasFileRow(event)) {
        // A key in a connected place: its bytes and whatever authorises them
        // travel as its source, and its address is what the run records.
        void readFileDrag(event).then((picked) => {
          if (picked === null) return
          const name = picked.name ?? picked.uri.split(/[\\/]/).pop() ?? picked.uri
          if (!accepts(spec, name)) {
            say(`${name} is not a ${spec.accept.join(' or ')} file.`)
            return
          }
          say('')
          this.chooseFile(spec, {
            value: picked.source.kind === 'local' ? picked.source.file.name : picked.uri,
            source: picked.source,
            name,
            ...(picked.source.kind === 'local' ? { size: picked.source.file.size } : {}),
          })
        })
        return
      }
      const files = filesFrom(event.dataTransfer)
      if (files.length > 0) take(files[0])
    })

    const commitAddress = (): void => {
      const typed = address.value.trim()
      if (typed !== '' && !isAddress(typed)) {
        say('An address starts with https:// or s3:// — a file on this computer is dropped above.')
        return
      }
      say('')
      this.shelf.set(spec.key, null)
      this.commit(spec.key, typed)
    }
    address.addEventListener('change', commitAddress)
    address.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        // As the text box does: the drawer's own Enter must not run a form the
        // box has not handed its value to.
        event.preventDefault()
        commitAddress()
      }
    })

    const sync = (): void => {
      const value = stringOr(this.params[spec.key], '').trim()
      const held = this.shelf.get(spec.key)
      const local = held !== undefined && held.value === value && value !== '' && !isAddress(value)
      // A picked row's address is held too, and reads as the file it is.
      const picked = held !== undefined && held.value === value && isAddress(value)
      zone.classList.toggle('is-held', local || picked)
      if (local || picked) {
        title.textContent = held.name ?? (local ? value : (value.split(/[\\/]/).pop() ?? value))
        detail.textContent =
          held.size === undefined
            ? 'drop or click to choose another'
            : `${fmt.bytes(held.size)} · drop or click to choose another`
      } else {
        title.textContent = spec.prompt
        detail.textContent = spec.accept.join(' or ')
      }
      forget.classList.toggle('hidden', !(local || picked))
      if (document.activeElement === address) return
      address.value = local || picked ? '' : value
    }
    sync()

    const group = el(
      'div',
      { class: 'param-file' },
      el('div', { class: 'param-file-row' }, zone, forget),
      address,
    )
    return {
      spec,
      wrapper: this.wrap(spec, this.named(spec, group, labelId), status),
      shown: false,
      sync,
    }
  }

  /** Hand a file to a {@link FileParam}, or take it back with `null`. */
  private chooseFile(spec: FileParam, held: HeldFile | null): void {
    this.shelf.set(spec.key, held)
    // Committed even where the value is unchanged, and synced by hand: the same
    // name dropped again is a different `File`, and `commit` returns early on a
    // value it already holds.
    const value = held?.value ?? ''
    if (sameValue(this.params[spec.key], value)) {
      for (const control of this.controls) control.sync()
      this.options.onChange(this.value)
      return
    }
    this.commit(spec.key, value)
  }

  /**
   * A box with nothing in it but what the reader types.
   *
   * The plainest control on the form, and the only one that offers no help at
   * all: no list to pick from, no bounds, no rewriting of what was typed beyond
   * trimming the ends. That is the point of {@link TextParam} — a motif is a
   * string in an alphabet the *task* knows and the form does not, so a control
   * that tried to be clever here would be guessing.
   *
   * Committed on `change` and on Enter, exactly as the locus box is, so a reader
   * who types a pattern and presses Enter has answered the form rather than
   * submitted it. Not committed per keystroke: every commit re-prices the run
   * and re-evaluates every `when`, and half a motif is a refusal the reader
   * would watch flicker past under their own typing.
   */
  private textControl(spec: TextParam): Control {
    const id = `${this.id}-${spec.key}`
    const box = el('input', {
      class: 'input',
      type: 'text',
      attrs: { id },
      ...(spec.placeholder === undefined ? {} : { placeholder: spec.placeholder }),
      // The same reason the locus box carries one: a bare `input` in a grid
      // track asks for its own default width and overflows the card.
      style: { width: '100%' },
    })
    const commit = (): void => this.commit(spec.key, box.value.trim())
    box.addEventListener('change', commit)
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        // Or the drawer's own Enter handling would submit a form the box has
        // not yet handed its value to.
        event.preventDefault()
        commit()
      }
    })
    const sync = (): void => {
      // Never under the cursor: a re-render lands mid-word otherwise, and the
      // held value is one keystroke behind what is on screen.
      if (document.activeElement === box) return
      box.value = stringOr(this.params[spec.key], '')
    }
    sync()
    return { spec, wrapper: this.wrap(spec, this.labelled(spec, box, id)), shown: false, sync }
  }

  /**
   * The seed, and a button that rolls a new one.
   *
   * The seed is on the form rather than hidden behind it because §18.4 asks for
   * two things at once: the same numbers twice, *and* a way to see whether a
   * result is robust to the sample. Typing the seed back in is the first; the
   * dice is the second, and a reader who has to invent a nine-digit number by
   * hand will press Run once and believe whatever comes out.
   */
  private seedControl(spec: SeedParam): Control {
    const id = `${this.id}-${spec.key}`
    const box = el('input', {
      class: 'input input-num input-step',
      type: 'number',
      attrs: { id, size: '1', step: '1', min: '0' },
    })
    const held = (): number => numberOr(this.params[spec.key], spec.default)
    const commitBox = (): void => {
      const typed = Number(box.value)
      if (!Number.isFinite(typed)) {
        box.value = String(held())
        return
      }
      const value = Math.max(0, Math.trunc(typed))
      box.value = String(value)
      this.commit(spec.key, value)
    }
    box.addEventListener('change', commitBox)
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commitBox()
    })
    // `rotate-cw` and not a die: the generated icon set has no dice, and a mark
    // sketched by hand here would be the one drawing in the app that nothing
    // regenerates (`ui/icons.ts`). What the button means is *again, differently*,
    // which is what this mark already says everywhere else it appears.
    const roll = iconButton(
      'rotate-cw',
      'Roll a new seed — the same seed gives the same numbers, a new one resamples',
      () => {
        const next = rollSeed(held())
        box.value = String(next)
        this.commit(spec.key, next)
      },
      { class: 'btn btn-icon', size: 14 },
    )
    const sync = (): void => {
      if (document.activeElement === box) return
      box.value = String(held())
    }
    sync()
    return {
      spec,
      wrapper: this.wrap(
        spec,
        this.labelled(spec, el('div', { class: 'plot-icon-row' }, box, roll), id),
      ),
      shown: false,
      sync,
    }
  }
}
