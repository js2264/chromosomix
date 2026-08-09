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
import { paramVisible } from '../analysis/types'
import type {
  AnalysisContext,
  ChoiceParam,
  ColumnParam,
  EntryParam,
  NumberParam,
  ParamSpec,
  ParamValue,
  Params,
  RegionParam,
  SeedParam,
  ToggleParam,
} from '../analysis/types'
import { DETAIL_SEP } from '../annotations/types'
import type { AnnotationEntry, AnnotationKind } from '../annotations/types'
import { el, fmt } from './dom'
import { iconButton } from './icons'

/**
 * Above this many choices, a row of buttons is a wall.
 *
 * Four fits across a folded drawer and stays readable as one row; five wraps,
 * and a wrapped segmented control reads as two unrelated groups. Past it the
 * same choice is a `<select>`, which costs a click and never lies about how many
 * options there are.
 */
const SEGMENTED_MAX = 4

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
}

// ---------------------------------------------------------------------------
// Resolving what the form points at
// ---------------------------------------------------------------------------

/** Which annotation kinds one entry parameter may name. */
function kindsFor(spec: EntryParam): readonly AnnotationKind[] {
  switch (spec.kind) {
    // A gene model and a peak set are one shape and two meanings (§8.1), and a
    // task that wants intervals wants both: the distinction is which drop area
    // the file landed in, which is the reader's business rather than a task's.
    case 'featureSet':
      return ['gtf', 'segments']
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
    return named || held === '' ? '' : (starredId(candidates) ?? '')
  }
  return starredId(candidates)
}

/**
 * A multi-select's ids, repaired the same way.
 *
 * Emptied by the repair — or never filled — a *required* list opens on the
 * starred entry, because a required list with nothing in it is a Run that cannot
 * happen and `defaultParams` has no way to name a file. `optional: true` is how
 * a descriptor says that an empty set is a legal answer, and there the empty set
 * is left alone.
 */
function resolveMany(
  spec: EntryParam,
  context: AnalysisContext,
  held: ParamValue | undefined,
): readonly string[] {
  const candidates = candidatesFor(spec, context)
  const live = new Set(candidates.map((entry) => entry.id))
  const kept = Array.isArray(held)
    ? held.filter((id): id is string => typeof id === 'string' && live.has(id))
    : []
  if (kept.length > 0 || spec.optional === true) return kept
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
  const out: Record<string, ParamValue> = { ...value }
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
  return out
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
 * Bins for a span in base pairs, at this file's resolution.
 *
 * The same expression `JobContext.toBins` evaluates in the worker, and it has to
 * be: the caption under the box is a promise about what the task will actually
 * do, and a caption that rounds differently from the kernel is a caption that is
 * wrong by one bin on half the values anybody types.
 */
function binsFor(bp: number, binsize: number): number {
  return Math.max(1, Math.round(bp / binsize))
}

/**
 * The framing as a locus, in the syntax the views' own boxes take.
 *
 * A view showing more than one contig answers with the **name** of the contig it
 * starts on rather than with a span, because a bare name is a whole contig to
 * every box in this app and a span that stops partway through the next sequence
 * is a region nobody meant. `''` where there is no map to read a framing from.
 */
function framingRegion(context: AnalysisContext): string {
  const framing = context.framing
  if (framing === null) return ''
  const [from, to] = framing.rows
  const contig = context.contigs.find(
    (item) => from >= item.startBin && from < item.startBin + item.bins,
  )
  if (contig === undefined) return ''
  if (to > contig.startBin + contig.bins) return contig.name
  const start = (from - contig.startBin) * framing.binsize
  const end = Math.min(contig.length, (to - contig.startBin) * framing.binsize)
  // 1-based and inclusive, which is how every genome browser writes a locus and
  // what `types.ts`'s `locus` field already documents the boxes as accepting.
  return `${contig.name}:${Math.max(1, Math.round(start) + 1)}-${Math.round(end)}`
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
  private readonly id = `pf${forms++}`

  constructor(private readonly options: ParamFormOptions) {
    this.specs = options.specs
    this.context = options.context
    this.params = { ...resolveEntryDefaults(options.specs, options.context, options.value) }
    this.fillRegions()

    this.el = el('div', { class: 'param-form' })
    for (const section of this.sections()) this.el.appendChild(this.group(section))
    for (const spec of this.specs) {
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
    for (const control of this.controls) {
      control.refill?.()
      control.sync()
    }
    this.syncVisibility()
  }

  /**
   * Take the form down.
   *
   * Every listener here is on a node this class owns, so detaching the root is
   * genuinely all of it — but the drawer's teardown should not have to know that,
   * and the first control that subscribes to a store will need somewhere to
   * unsubscribe from.
   */
  destroy(): void {
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
    const out = ['']
    for (const spec of this.specs) {
      const section = spec.section ?? ''
      if (!out.includes(section)) out.push(section)
    }
    return out.filter((section) => this.specs.some((spec) => (spec.section ?? '') === section))
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
  private wrap(spec: ParamSpec, field: HTMLElement, caption?: HTMLElement): HTMLElement {
    return el(
      'div',
      { class: 'param-row' },
      field,
      caption,
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

  /** One edit, complete. Nothing else in this module writes `params`. */
  private commit(key: string, value: ParamValue): void {
    if (sameValue(this.params[key], value)) return
    this.params[key] = value
    for (const control of this.controls) {
      if (control.spec.kind === 'column') control.refill?.()
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
      const shown = paramVisible(control.spec, this.params)
      const ref = after.get(section) ?? null
      if (shown && !control.shown) rows.insertBefore(control.wrapper, ref)
      else if (!shown && control.shown) control.wrapper.remove()
      control.shown = shown
      if (shown) after.set(section, control.wrapper)
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
      const region = spec.default ?? framingRegion(this.context)
      if (region !== '') this.params[spec.key] = region
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
      case 'region':
        return this.regionControl(spec)
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

    // Base pairs are a property of the question and bins are a property of the
    // file (§18.2), so the box takes the first and prints the second: a reader
    // asking for a 100 kb window on a 10 kb file is asking for ten bins, and the
    // difference between ten and eleven is the difference between a diamond that
    // resolves a boundary and one that does not.
    const caption =
      spec.unit === 'bp' && this.context.binsize > 0 ? el('div', { class: 'hint' }) : null

    const clamp = (raw: number): number => {
      let value = spec.integer === true ? Math.round(raw) : raw
      if (spec.min !== undefined) value = Math.max(spec.min, value)
      if (spec.max !== undefined) value = Math.min(spec.max, value)
      return value
    }
    const held = (): number => numberOr(this.params[spec.key], spec.default)
    const showBins = (value: number): void => {
      if (caption === null) return
      const bins = binsFor(value, this.context.binsize)
      caption.textContent = `${fmt.int(bins)} ${bins === 1 ? 'bin' : 'bins'} at ${fmt.bp(
        this.context.binsize,
      )}`
    }
    const show = (value: number): void => {
      box.value = String(value)
      if (slider !== null) slider.value = String(value)
      showBins(value)
    }
    const commitBox = (): void => {
      const typed = Number(box.value)
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
    // Typed digits reach the caption but not the parameter: the bin count is
    // feedback about what is being typed, while a commit re-prices the run and
    // must wait for the reader to have finished.
    box.addEventListener('input', () => {
      const typed = Number(box.value)
      if (Number.isFinite(typed)) showBins(typed)
    })
    if (slider !== null) {
      slider.addEventListener('input', () => {
        const value = clamp(Number(slider.value))
        box.value = String(value)
        showBins(value)
      })
      // On `change` and not on `input`: a drag across a two-hundred-pixel track
      // is two hundred commits, which is two hundred cost estimates for one
      // decision the reader has not made yet.
      slider.addEventListener('change', () => this.commit(spec.key, clamp(Number(slider.value))))
    }

    // The unit is written beside the box rather than folded into the label,
    // because it belongs to the number: `%` is drawn with its sign, and `bins`
    // beside a box is what says the reader is not typing base pairs this time.
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
    return { spec, wrapper: this.wrap(spec, field, caption ?? undefined), shown: false, sync }
  }

  /**
   * A choice: buttons at four options or fewer, a select above that.
   *
   * The buttons are the same mark the overlay toggles are, so "this one is in
   * force" is the accent border a reader has already learned everywhere else in
   * the app rather than a second convention for the same fact.
   */
  private choiceControl(spec: ChoiceParam): Control {
    const id = `${this.id}-${spec.key}`
    const held = (): string => stringOr(this.params[spec.key], spec.default)

    if (spec.options.length > SEGMENTED_MAX) {
      const select = el('select', { class: 'select', attrs: { id } })
      for (const option of spec.options) {
        select.appendChild(
          el('option', {
            value: option.value,
            text: option.label,
            ...(option.hint === undefined ? {} : { title: option.hint }),
          }),
        )
      }
      select.addEventListener('change', () => this.commit(spec.key, select.value))
      const sync = (): void => {
        select.value = held()
      }
      sync()
      return {
        spec,
        wrapper: this.wrap(spec, this.labelled(spec, select, id)),
        shown: false,
        sync,
      }
    }

    const row = el('div', { class: 'plot-icon-row' })
    const buttons = spec.options.map((option) => {
      const node = el('button', {
        class: 'btn btn-toggle',
        type: 'button',
        text: option.label,
        title: option.hint ?? `${spec.label}: ${option.label}`,
      })
      node.addEventListener('click', () => this.commit(spec.key, option.value))
      row.appendChild(node)
      return { value: option.value, node }
    })
    const sync = (): void => {
      const value = held()
      for (const button of buttons) {
        button.node.setAttribute('aria-pressed', String(button.value === value))
      }
    }
    sync()
    return {
      spec,
      wrapper: this.wrap(spec, this.blocked(spec, row, `${id}-label`)),
      shown: false,
      sync,
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
    }
    sync()
    return {
      spec,
      wrapper: this.wrap(spec, this.blocked(spec, el('div', { class: 'plot-icon-row' }, node), labelId)),
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

  /** A locus, in the syntax the views' own boxes take. */
  private regionControl(spec: RegionParam): Control {
    const id = `${this.id}-${spec.key}`
    const box = el('input', {
      class: 'input input-region param-region',
      type: 'text',
      attrs: { id },
      placeholder: framingRegion(this.context),
      title: 'A contig, or a contig and a span — the same thing the locus boxes take.',
      // The locus box's own 24 rem is a width for a toolbar. In a column it
      // overflows the card, and a grid track cannot shrink an element below the
      // width it asks for.
      style: { width: '100%' },
    })
    const commit = (): void => this.commit(spec.key, box.value.trim())
    box.addEventListener('change', commit)
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit()
    })
    const sync = (): void => {
      if (document.activeElement === box) return
      box.value = stringOr(this.params[spec.key], '')
      box.placeholder = framingRegion(this.context)
    }
    sync()
    return {
      spec,
      wrapper: this.wrap(spec, this.labelled(spec, box, id)),
      shown: false,
      sync,
      refill: sync,
    }
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
