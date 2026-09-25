/**
 * The settings of several ticked tracks, edited as one (§8.1).
 *
 * The Tracks card's batch box used to be four actions — one colour, one
 * autoscale group, the tallest height, hide or remove — and everything else a
 * track has was six trips through six rows. Six ATAC replicates want one pair
 * of limits, one style, one edge; that is the commonest reason to tick them at
 * all. So the box carries a row's settings, the same controls under the same
 * words (`ui/laneSettings.ts`), each written to every ticked row it means
 * something to.
 *
 * **What a control shows is what the rows share.** A value every ticked row
 * has is shown as that value; rows that disagree are shown as *mixed* — an
 * empty box with that word in it, a `mixed` entry at the top of a picker, a
 * hatched segment among the edges — and nothing is written until the reader
 * picks, so opening the box changes no track.
 *
 * **A control is offered when it means something to at least one ticked row,
 * and written only to those.** A gene model and two bigWigs ticked together
 * get one style picker, and the pick lands on the two bigWigs; the tooltip says
 * how many of the ticked rows a control reaches when that is not all of them.
 * Refusing the batch because one row cannot take one setting would make the
 * reader untick it to set the others, which is the trip this is here to save.
 *
 * Every write goes through {@link AnnotationStore.restyleEach}, so a limit
 * typed for twelve tracks is one change to the store and not twelve.
 */

import type { AnnotationStore } from '../annotations/store'
import {
  LANE_EDGES,
  TRACK_MODES,
  TRACK_SCALES,
  emptyPlacement,
  hasTrackControls,
  scaleOf,
  type AnnotationEntry,
  type LaneEdge,
  type TrackMode,
  type TrackScale,
} from '../annotations/types'
import { COLORMAP_NAMES } from '../render/colormaps'
import { button, el, trimNumber } from './dom'
import { iconButton } from './icons'
import type { PlacementMap } from './lanePlacement'
import { MAX_SIZE, MIN_SIZE } from './laneSettings'

/** What the ticked rows say about one setting: one value, or several. */
type Shared<T> = { same: true; value: T } | { same: false }

/** The value every row gives, or `mixed`, by `equal` (identity by default). */
function sharedOf<T>(
  rows: readonly AnnotationEntry[],
  read: (entry: AnnotationEntry) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): Shared<T> {
  if (rows.length === 0) return { same: false }
  const first = read(rows[0])
  for (const entry of rows) if (!equal(read(entry), first)) return { same: false }
  return { same: true, value: first }
}

/** The word a mixed control shows, in every one of them. */
const MIXED = 'mixed'

/** `(3 of 5 ticked)` where a control reaches fewer rows than are ticked. */
function reach(applies: readonly AnnotationEntry[], ticked: readonly AnnotationEntry[]): string {
  return applies.length === ticked.length
    ? `all ${applies.length} ticked tracks`
    : `${applies.length} of the ${ticked.length} ticked tracks`
}

/** The rows a lane control means something to: drawn beside a map, not on it. */
function lanes(rows: readonly AnnotationEntry[]): AnnotationEntry[] {
  return rows.filter(
    (entry) => (entry.card === 'linear' || entry.card === 'synthetic') && entry.kind !== 'structure',
  )
}

/** The rows with a value axis and a style: signal tracks, a BAM's depth. */
function signals(rows: readonly AnnotationEntry[]): AnnotationEntry[] {
  return rows.filter((entry) => hasTrackControls(entry.kind))
}

/** The rows with a pair of limits: a signal, a sequence's GC, a barChart. */
function limited(rows: readonly AnnotationEntry[]): AnnotationEntry[] {
  return rows.filter(
    (entry) => hasTrackControls(entry.kind) || entry.kind === 'sequence' || entry.kind === 'barchart',
  )
}

/** A labelled field in the row settings' own shape, with a tooltip. */
function field(label: string, title: string, ...controls: HTMLElement[]): HTMLElement {
  return el(
    'label',
    { class: 'field ann-field ann-field-tight', title },
    el('span', { class: 'field-label', text: label }),
    ...controls,
  )
}

/** A select whose first entry says the rows disagree, until a pick is made. */
function pickerOf(
  options: ReadonlyArray<{ value: string; text: string }>,
  shared: Shared<string>,
): HTMLSelectElement {
  const select = el('select', { class: 'select' })
  if (!shared.same) {
    const mixed = el('option', { value: '', text: MIXED })
    mixed.disabled = true
    select.appendChild(mixed)
  }
  for (const option of options) select.appendChild(el('option', option))
  select.value = shared.same ? shared.value : ''
  if (!shared.same) select.selectedIndex = 0
  return select
}

export interface BatchFieldsOptions {
  store: AnnotationStore
  /** The ticked rows, in the order the card lists them. */
  rows: readonly AnnotationEntry[]
  /** Every map a lane may be drawn on — the Tracks card's list. */
  maps: readonly PlacementMap[]
  /** A 1D browser has one axis and no edges to choose between. */
  context: 'map' | 'browser'
  /** Every group name in use, for the group picker. */
  groups: readonly string[]
  /** A new group was named and given to the rows — the gesture is over. */
  onCoined(): void
}

/**
 * Every setting the ticked rows share, as the fields of a row's settings body.
 *
 * In the order a row lists them — the lane, then the axis, then the group,
 * then the edges — so a reader who knows one row's settings reads this box
 * without learning it.
 */
export function batchFields(options: BatchFieldsOptions): HTMLElement[] {
  const { rows } = options
  const out: HTMLElement[] = []
  const laneRows = lanes(rows)
  const signalRows = signals(rows)
  const styled = rows.filter((entry) => hasTrackControls(entry.kind) || entry.kind === 'sequence')

  const first: HTMLElement[] = [colourField(options)]
  if (laneRows.length > 0) first.push(heightField(options, laneRows))
  out.push(el('div', { class: 'ann-inline' }, ...first))

  if (styled.length > 0 || signalRows.length > 0) {
    out.push(
      el(
        'div',
        { class: 'ann-inline' },
        ...(styled.length > 0 ? styleFields(options, styled, signalRows) : []),
        ...(signalRows.length > 0 ? [scaleField(options, signalRows), flipButton(options, signalRows)] : []),
      ),
    )
  }
  const withLimits = limited(rows)
  if (withLimits.length > 0) out.push(limitsField(options, withLimits))
  if (signalRows.length > 0) out.push(groupField(options, signalRows))

  const placeable = laneRows.filter((entry) => entry.kind !== 'reads')
  if (options.context !== 'browser' && placeable.length > 0) {
    out.push(placementField(options, placeable))
  }
  const overlays = rows.filter((entry) => entry.card === 'overlay')
  if (overlays.length > 0) out.push(opacityField(options, overlays))
  return out
}

// ---------------------------------------------------------------------------
// The fields
// ---------------------------------------------------------------------------

/** One colour for all of them — every row has one. */
function colourField(options: BatchFieldsOptions): HTMLElement {
  const { store, rows } = options
  const shared = sharedOf(rows, (entry) => entry.style.colour)
  const input = el('input', {
    class: 'ann-swatch',
    type: 'color',
    // A colour input cannot be empty, so a mixed set shows its first row's —
    // and says so in the tooltip and by the hatch the stylesheet draws round it.
    value: shared.same ? shared.value : rows[0].style.colour,
  })
  input.classList.toggle('is-mixed', !shared.same)
  input.title = shared.same
    ? `One colour for ${reach(rows, rows)}`
    : `The ticked tracks have different colours; a pick gives ${reach(rows, rows)} this one`
  input.addEventListener('input', () => {
    input.classList.remove('is-mixed')
    store.restyleEach(
      rows.map((entry) => entry.id),
      { colour: input.value },
    )
  })
  return field('colour', input.title, input)
}

/** One thickness, typed — `heightField`'s box, for several lanes. */
function heightField(options: BatchFieldsOptions, applies: readonly AnnotationEntry[]): HTMLElement {
  const { store } = options
  const shared = sharedOf(applies, (entry) => Math.round(entry.style.size))
  const box = el('input', {
    class: 'input input-num ann-size',
    type: 'number',
    value: shared.same ? String(shared.value) : '',
    placeholder: shared.same ? '' : MIXED,
  })
  box.min = String(MIN_SIZE)
  box.max = String(MAX_SIZE)
  box.step = '1'
  box.addEventListener('change', () => {
    // On the string, for the reason `heightField` gives: `Number('')` is 0,
    // and an emptied box committing the floor would collapse every lane ticked.
    const raw = box.value.trim()
    const typed = raw === '' ? Number.NaN : Math.round(Number(raw))
    if (!Number.isFinite(typed)) {
      box.value = shared.same ? String(shared.value) : ''
      return
    }
    const clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, typed))
    box.value = String(clamped)
    store.restyleEach(
      applies.map((entry) => entry.id),
      { size: clamped },
    )
  })
  return field(
    'height',
    `Lane thickness in pixels, ${MIN_SIZE} to ${MAX_SIZE}, for ${reach(applies, options.rows)}.`,
    box,
    el('span', { class: 'ann-unit', text: 'px' }),
  )
}

/**
 * The style and, under a heatmap, the colours — `styleFields`, for several.
 *
 * Built as a pair for that function's reason: a select keeps focus after a
 * pick, the card defers its rebuild while it does, and the colours have to
 * appear on the pick that asks for them.
 */
function styleFields(
  options: BatchFieldsOptions,
  styled: readonly AnnotationEntry[],
  signalRows: readonly AnnotationEntry[],
): HTMLElement[] {
  const { store } = options
  const mode = pickerOf(
    TRACK_MODES.map((value) => ({ value, text: value })),
    sharedOf(styled, (entry) => entry.style.mode),
  )
  const colormap = pickerOf(
    [{ value: '', text: 'auto' }, ...COLORMAP_NAMES.map((name) => ({ value: name, text: name }))],
    sharedOf(signalRows, (entry) =>
      typeof entry.style.colormap === 'string' ? entry.style.colormap : '',
    ),
  )
  const colours = field(
    'colours',
    `The colormap of the ticked heatmap lanes. Auto reads the data: diverging about zero where the ` +
      'values cross it, a ramp where they do not.',
    colormap,
  )
  const showColours = (): void => {
    const heatmaps = signalRows.some((entry) => (store.byId(entry.id) ?? entry).style.mode === 'heatmap')
    colours.classList.toggle('hidden', signalRows.length === 0 || !heatmaps)
  }
  showColours()
  mode.addEventListener('change', () => {
    if (mode.value === '') return
    store.restyleEach(
      styled.map((entry) => entry.id),
      { mode: mode.value as TrackMode },
    )
    showColours()
  })
  colormap.addEventListener('change', () =>
    store.restyleEach(
      signalRows.map((entry) => entry.id),
      { colormap: colormap.value },
    ),
  )
  return [
    field('style', `How the values are drawn, for ${reach(styled, options.rows)}.`, mode),
    colours,
  ]
}

/** Linear or log₂ — `scaleField`, for several. */
function scaleField(options: BatchFieldsOptions, applies: readonly AnnotationEntry[]): HTMLElement {
  const select = pickerOf(
    TRACK_SCALES.map((value) => ({ value, text: value === 'log2' ? 'log₂' : value })),
    sharedOf(applies, (entry) => scaleOf(entry.style)),
  )
  select.addEventListener('change', () => {
    if (select.value === '') return
    options.store.restyleEach(
      applies.map((entry) => entry.id),
      { scale: select.value as TrackScale },
    )
  })
  return field(
    'scale',
    `The axis ${reach(applies, options.rows)} are drawn on. A value at or below zero has no ` +
      'logarithm and is drawn as a gap.',
    select,
  )
}

/**
 * Upside down, or not — lit when every one is, hatched when some are.
 *
 * A press on a mixed set flips them all rather than turning each over: the
 * reader looking at three hanging lanes and one standing one wants four the
 * same way, and a toggle per row would leave them as mixed as they were.
 */
function flipButton(options: BatchFieldsOptions, applies: readonly AnnotationEntry[]): HTMLElement {
  const shared = sharedOf(applies, (entry) => entry.style.flip)
  const on = shared.same && shared.value
  const node = iconButton(
    'flip-vertical',
    shared.same
      ? on
        ? `Stand ${reach(applies, options.rows)} the right way up again`
        : `Invert the value axis of ${reach(applies, options.rows)}, so they grow downwards`
      : `Some of these are inverted: a press inverts ${reach(applies, options.rows)}`,
    () =>
      options.store.restyleEach(
        applies.map((entry) => entry.id),
        { flip: !on },
      ),
    { class: `btn btn-icon ann-flip${on ? ' is-on' : ''}${shared.same ? '' : ' is-mixed'}`, size: 14 },
  )
  node.setAttribute('aria-pressed', shared.same ? String(on) : 'mixed')
  return node
}

/**
 * One pair of limits, or auto — `limitsField`, for several.
 *
 * Both bounds are needed before anything is written: a batch has no single
 * range to seed the other box from, and half a pair applied to twelve tracks
 * would be twelve guesses at the other half. Typing the second bound is the
 * commit; an inverted or unreadable pair is refused the way a row refuses it.
 */
function limitsField(options: BatchFieldsOptions, applies: readonly AnnotationEntry[]): HTMLElement {
  const { store } = options
  const shared = sharedOf(
    applies,
    (entry) => entry.style.limits,
    (a, b) => a.auto === b.auto && (a.auto || (a.min === b.min && a.max === b.max)),
  )
  const manual = shared.same && !shared.value.auto ? shared.value : null
  const min = el('input', {
    class: 'input input-num',
    type: 'number',
    value: manual === null ? '' : trimNumber(manual.min, 3),
    placeholder: shared.same ? 'min' : MIXED,
    title: 'Floor of the value axis',
  })
  const max = el('input', {
    class: 'input input-num',
    type: 'number',
    value: manual === null ? '' : trimNumber(manual.max, 3),
    placeholder: shared.same ? 'max' : MIXED,
    title: 'Ceiling of the value axis',
  })
  const allAuto = shared.same && shared.value.auto
  const auto = iconButton(
    'chevrons-up-down',
    allAuto
      ? 'Every one of these is on its own data’s range already.'
      : `Back to each track’s own range, rescaling as the view moves — ${reach(applies, options.rows)}.`,
    () =>
      store.restyleEach(
        applies.map((entry) => entry.id),
        (style) => ({ limits: { ...style.limits, auto: true } }),
      ),
    { class: 'btn btn-icon clip-auto', size: 14 },
  )
  auto.disabled = allAuto
  const note = el('span', {
    class: 'clip-note',
    text: !shared.same
      ? MIXED
      : shared.value.auto
        ? 'auto'
        : `clipped · ${trimNumber(shared.value.min, 3)} – ${trimNumber(shared.value.max, 3)}`,
  })
  const commit = (): void => {
    if (min.value.trim() === '' || max.value.trim() === '') return
    const low = Number(min.value)
    const high = Number(max.value)
    if (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low)) {
      for (const box of [min, max]) {
        box.classList.add('is-bad')
        window.setTimeout(() => box.classList.remove('is-bad'), 700)
      }
      return
    }
    note.textContent = `clipped · ${trimNumber(low, 3)} – ${trimNumber(high, 3)}`
    auto.disabled = false
    store.restyleEach(
      applies.map((entry) => entry.id),
      { limits: { auto: false, min: low, max: high } },
    )
  }
  for (const box of [min, max]) {
    box.step = 'any'
    box.addEventListener('change', commit)
  }
  return el(
    'div',
    {
      class: 'field field-block',
      title:
        `One floor and one ceiling for ${reach(applies, options.rows)}. Auto gives each its own ` +
        'range again; a group is what makes several share one while they rescale.',
    },
    el('span', { class: 'field-label', text: 'limits' }),
    el('div', { class: 'ann-limits' }, min, max, auto),
    note,
  )
}

/**
 * One autoscale group — the batch box's first control, kept.
 *
 * `new group…` asks for a name and, once the rows are in it, clears the ticks:
 * the set now exists as a group, and leaving the ticks on would leave a second
 * selection saying the same thing for the next batch action to act on.
 */
function groupField(options: BatchFieldsOptions, applies: readonly AnnotationEntry[]): HTMLElement {
  const NEW = ' new'
  const select = pickerOf(
    [
      { value: ' none', text: 'no group' },
      ...options.groups.map((name) => ({ value: name, text: name })),
      { value: NEW, text: 'new group…' },
    ],
    // `''` is how *no group* is stored, and `''` is the mixed entry's value
    // here, so the picker speaks of none as `' none'` — a leading space cannot
    // occur in a name, which is trimmed before it is stored.
    sharedOf(applies, (entry) => (entry.style.group === '' ? ' none' : entry.style.group)),
  )
  select.addEventListener('change', () => {
    let name = select.value
    if (name === '') return
    const coined = name === NEW
    if (coined) {
      name = window.prompt('Name for the new autoscale group')?.trim() ?? ''
      if (name === '') {
        select.selectedIndex = 0
        return
      }
    }
    options.store.restyleEach(
      applies.map((entry) => entry.id),
      { group: name === ' none' ? '' : name },
    )
    if (coined) options.onCoined()
  })
  return field(
    'group',
    `Tracks sharing a group share one range, over everything they show — ${reach(applies, options.rows)}.`,
    select,
  )
}

/**
 * The same edges for all of them — `placementField`, for several.
 *
 * A segment is lit when every ticked lane is on that edge of that map, hatched
 * when some are, and plain when none is. A press on a lit one takes them all
 * off it (off their last edge is off *that map*, as on a row); on any other it
 * puts them all there, beside whatever edges each already has.
 */
function placementField(options: BatchFieldsOptions, applies: readonly AnnotationEntry[]): HTMLElement {
  const { store, maps } = options
  const named = maps.length > 1
  const rowFor = (map: PlacementMap): HTMLElement => {
    const edgeButton = (edge: LaneEdge): HTMLElement => {
      const on = applies.filter((entry) => store.laneFor(entry.id, map.id)?.placement[edge] === true)
      const all = on.length === applies.length
      const some = on.length > 0 && !all
      const where = `the ${edge} edge${named ? ` of ${map.label}` : ''}`
      const node = el('button', {
        class: 'btn btn-toggle ann-place',
        type: 'button',
        text: edge,
        title: all
          ? `Take ${reach(applies, options.rows)} off ${where}`
          : some
            ? `${on.length} of these are on ${where}: a press puts ${reach(applies, options.rows)} there`
            : `Draw ${reach(applies, options.rows)} on ${where} as well`,
      })
      node.setAttribute('aria-pressed', all ? 'true' : some ? 'mixed' : 'false')
      if (map.edges !== undefined && !map.edges.includes(edge)) {
        node.disabled = true
        node.title = `${map.label} has no ${edge} edge: a stack of tracks is drawn along one axis`
      }
      node.addEventListener('click', () => {
        for (const entry of applies) {
          const placement = store.laneFor(entry.id, map.id)?.placement ?? emptyPlacement()
          const next = { ...placement, [edge]: !all }
          if (LANE_EDGES.every((side) => !next[side])) store.unplaceFrom(entry.id, map.id)
          else store.placeAt(entry.id, map.id, next)
        }
      })
      return node
    }
    const edges = el('div', { class: 'ann-places' }, ...LANE_EDGES.map(edgeButton))
    return named
      ? el(
          'div',
          { class: 'ann-place-map' },
          el('span', { class: 'ann-place-name', text: map.label, attrs: { title: map.label } }),
          edges,
        )
      : edges
  }
  return el(
    'div',
    {
      class: 'field ann-field ann-field-places',
      title: `Where ${reach(applies, options.rows)} are drawn.`,
    },
    el('span', { class: 'field-label', text: 'location' }),
    el(
      'div',
      { class: 'ann-place-maps' },
      ...maps.map(rowFor),
      ...(named
        ? [
            el(
              'div',
              { class: 'ann-place-all' },
              button(
                'every map',
                () => {
                  for (const entry of applies) store.propagateTo(entry.id, maps.map((map) => map.id))
                },
                {
                  class: 'btn btn-quiet',
                  title: 'Draw all of these on every map, at the edges each is already on.',
                },
              ),
              button(
                'no map',
                () => {
                  for (const entry of applies) store.withdrawFrom(entry.id)
                },
                {
                  class: 'btn btn-quiet',
                  title: 'Take all of these off every map. They stay in the list, ready to put back.',
                },
              ),
            ),
          ]
        : []),
    ),
  )
}

/** How solid the ticked overlays are drawn — `opacityField`, for several. */
function opacityField(options: BatchFieldsOptions, applies: readonly AnnotationEntry[]): HTMLElement {
  const shared = sharedOf(applies, (entry) => Math.round(entry.style.opacity * 100))
  const input = el('input', {
    class: 'ann-range',
    type: 'range',
    value: String(shared.same ? shared.value : Math.round(applies[0].style.opacity * 100)),
  })
  input.min = '10'
  input.max = '100'
  input.addEventListener('input', () =>
    options.store.restyleEach(
      applies.map((entry) => entry.id),
      { opacity: Number(input.value) / 100 },
    ),
  )
  return field(
    'opacity',
    shared.same
      ? `How solid ${reach(applies, options.rows)} are drawn on the map.`
      : `The ticked overlays are drawn at different opacities; a move sets ${reach(applies, options.rows)}.`,
    input,
  )
}
