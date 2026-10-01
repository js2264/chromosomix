/**
 * The controls a lane's settings body is made of, for the cards that have one.
 *
 * Moved out of `ui/AnnotationCard.ts` when a second card grew rows with lanes
 * of their own (§8.12). They are the same controls in both places on purpose:
 * a metadata lane and a loaded track are the same kind of thing on the map —
 * one thickness, one style, one pair of limits, one edge — and a reader who has
 * set a track's ceiling should not meet a second, differently-shaped ceiling
 * control the next card down.
 *
 * Free functions over `(store, entry)` rather than methods, because that is the
 * whole of what they need: every one of them reads the entry it was handed and
 * writes through `restyle`, and the card they are mounted in rebuilds when the
 * store says so. That is also what makes them usable from a card that keeps no
 * per-row state at all.
 */

import type { AnnotationStore } from '../annotations/store'
import {
  FEATURE_DISPLAYS,
  featureFields,
  featuresOf,
  fieldFor,
  type FeatureDisplay,
  type FeatureStyle,
} from '../annotations/fields'
import { glyphExtentOfRow } from '../render/features'
import { featureColouring, rampStops } from '../render/featureInk'
import {
  COLOUR_BY,
  PAIR_LAYOUTS,
  TRACK_MODES,
  TRACK_SCALES,
  readsOf,
  scaleOf,
  translationOf,
  type AnnotationEntry,
  type ColourBy,
  type FeatureSet,
  type PairLayout,
  type ReadStyle,
  type TrackMode,
  type TrackScale,
  type TranslationStyle,
} from '../annotations/types'
import { GENETIC_CODES } from '../annotations/codons'
import { groupsFor } from '../annotations/bam/reads'
import { COLORMAP_NAMES } from '../render/colormaps'
import { MOD_INK, readPalette } from '../render/alignments'
import { modLabel } from '../annotations/bam/basemods'
import { modCodesOf, onModCodes } from './modCodes'
import { button, el, trimNumber } from './dom'
import { iconButton } from './icons'

/** The thinnest and thickest a lane may be dragged or typed to, in CSS pixels. */
export const MIN_SIZE = 12
export const MAX_SIZE = 400

/** A labelled row, as every settings body writes one. */
export function settingsField(
  label: string,
  control: HTMLElement,
  hint?: string,
): HTMLElement {
  return el(
    'label',
    { class: 'field ann-field', title: hint ?? '' },
    el('span', { class: 'field-label', text: label }),
    control,
  )
}

/**
 * Lane thickness in pixels.
 *
 * A number box rather than a slider. A slider is for a quantity with no natural
 * unit, and this one has the most natural unit there is: the lane is *n* pixels
 * tall on the screen you are looking at. Typing 60 is one gesture; finding 60
 * on a 120-pixel track running from 12 to 140 is a drag, an overshoot and a
 * squint.
 */
export function heightField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const size = el('input', {
    class: 'input input-num ann-size',
    type: 'number',
    value: String(Math.round(entry.style.size)),
    title: `Lane thickness in pixels — ${MIN_SIZE} to ${MAX_SIZE}.`,
  })
  size.min = String(MIN_SIZE)
  size.max = String(MAX_SIZE)
  size.step = '1'
  size.addEventListener('change', () => {
    // On the *string*: `Number('')` is 0, which is finite, so this guard never
    // fired and clearing the box committed the floor — every lane in the stack
    // collapsing to its minimum thickness, from a gesture that said nothing.
    // A `type="number"` box reports an empty string for a cleared box and for
    // anything it could not parse alike. `ui/ClipRange.ts` states the rule.
    const raw = size.value.trim()
    const typed = raw === '' ? Number.NaN : Math.round(Number(raw))
    if (!Number.isFinite(typed)) {
      size.value = String(Math.round(entry.style.size))
      return
    }
    // Clamped rather than refused: a typed 900 is a reader asking for a taller
    // lane than exists, and the tallest one is the answer to that.
    const clamped = Math.max(MIN_SIZE, Math.min(MAX_SIZE, typed))
    size.value = String(clamped)
    store.restyle(entry.id, { size: clamped })
  })
  return el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'height' }),
    size,
    el('span', { class: 'ann-unit', text: 'px' }),
  )
}

/**
 * Area, line, bars, points, a heatmap or a ribbon — how a value profile is
 * resolved into ink (`TrackMode`).
 *
 * The first four draw the value as a position across the lane — `points` as a
 * dot per value, a Manhattan plot's picture; `heatmap` draws it as a colour,
 * which costs no height and is the one several tracks can be stacked in without
 * a screen's worth of lane each.
 */
export function modeField(
  store: AnnotationStore,
  entry: AnnotationEntry,
  onPick?: (mode: TrackMode) => void,
): HTMLElement {
  const select = el('select', { class: 'select' })
  for (const mode of TRACK_MODES) {
    select.appendChild(el('option', { value: mode, text: mode }))
  }
  select.value = entry.style.mode
  select.addEventListener('change', () => {
    const mode = select.value as TrackMode
    store.restyle(entry.id, { mode })
    onPick?.(mode)
  })
  return el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'style' }),
    select,
  )
}

/**
 * Which colormap a heatmap lane fills with.
 *
 * **Shown only when the style is a heatmap**, because on a line track it is a
 * setting that does nothing, and a control that silently does nothing is worse
 * than an absent one — the rule `ui/AnnotationCard.ts` already applies to the
 * edge picker on a pile of reads.
 *
 * The first entry is *auto*, and it is the default rather than a convenience:
 * a track whose values cross zero is a departure from something and wants a
 * diverging map with its middle on the zero, while a one-signed one wants a
 * ramp — the same reading `resolveLimits` makes about the axis. A reader who
 * disagrees picks; a reader who does not is right far more often than a fixed
 * choice would be.
 */
export function colormapField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const select = el('select', { class: 'select' })
  select.appendChild(el('option', { value: '', text: 'auto' }))
  for (const name of COLORMAP_NAMES) {
    select.appendChild(el('option', { value: name, text: name }))
  }
  select.value = typeof entry.style.colormap === 'string' ? entry.style.colormap : ''
  select.title =
    'Auto reads the data: diverging about zero where the values cross it, a ramp where they do not.'
  select.addEventListener('change', () => store.restyle(entry.id, { colormap: select.value }))
  return el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'colours' }),
    select,
  )
}

/**
 * The style and, under a heatmap, the colours — as a pair.
 *
 * They are built together because one decides whether the other is there, and
 * the card cannot do it: a `<select>` keeps focus after a pick, and every card
 * defers its rebuild while a control holds a value the reader may still be
 * giving. Wiring the picker to the style directly means the colours appear on
 * the pick that asked for them rather than on the next click somewhere else.
 */
export function styleFields(store: AnnotationStore, entry: AnnotationEntry): HTMLElement[] {
  const colours = colormapField(store, entry)
  const show = (mode: TrackMode): void => {
    colours.classList.toggle('hidden', mode !== 'heatmap')
  }
  show(entry.style.mode)
  return [modeField(store, entry, show), colours]
}

/**
 * The axis this lane's values are drawn on: linear, or log₂.
 *
 * Beside the drawing style rather than beside the limits, because it is a
 * question about the *lane* and not about its range — the limits then follow it,
 * reading in whatever units the axis is in, which is what makes an autoscaled
 * log lane land on its own data rather than on the linear span of it.
 *
 * The one lane that needs it is a ratio. Linear puts "half" in the bottom
 * half-unit and "double" a whole unit above the middle, so the same finding is
 * drawn at two very different sizes; log₂ makes them symmetric about a baseline
 * the plot already draws. Which is why the combine control no longer offers a
 * log₂ *operation*: a ratio and its logarithm were two rows holding the same
 * numbers, and only one of them could be exported as the quantity it measured.
 */
export function scaleField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const select = el('select', { class: 'select' })
  for (const scale of TRACK_SCALES) {
    select.appendChild(el('option', { value: scale, text: scale === 'log2' ? 'log₂' : scale }))
  }
  select.value = scaleOf(entry.style)
  select.title =
    'The axis this lane is drawn on. A value at or below zero has no logarithm and is drawn as a ' +
    'gap, so log₂ suits a ratio and not a difference.'
  select.addEventListener('change', () =>
    store.restyle(entry.id, { scale: select.value as TrackScale }),
  )
  return el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'scale' }),
    select,
  )
}

/**
 * Draw this lane's value axis upside down.
 *
 * For the half of an experiment that is measured downwards. Stranded RNA-seq is
 * the case that asks for it: forward reads growing up from a shared floor and
 * reverse reads growing *down* from it is one picture of one locus, and two
 * lanes both growing upwards is two pictures a reader has to mirror in their
 * head. A button rather than a checkbox, because it is a state the lane is *in*
 * and the lane shows it.
 */
export function flipButton(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const node = iconButton(
    'flip-vertical',
    'Invert this lane’s value axis, so it grows downwards',
    () => store.restyle(entry.id, { flip: !entry.style.flip }),
    { class: `btn btn-icon ann-flip${entry.style.flip ? ' is-on' : ''}`, size: 14 },
  )
  node.setAttribute('aria-pressed', String(entry.style.flip))
  return node
}

/** How solid the lane is drawn, for the ones that can overlap something. */
/**
 * How a called interval set is drawn on the matrix face: as a box, or as a mark.
 *
 * Here rather than on the Tracks card, which is where it was, because a computed
 * boundary set is an overlay exactly as a dropped BED one is and appears on a
 * different card — so a control that lived as a private method of the one card
 * was a control the other kind of row could not be given at all.
 */
export function shapeField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const select = el('select', { class: 'select' })
  select.appendChild(el('option', { value: 'element', text: 'element (box)' }))
  select.appendChild(el('option', { value: 'border', text: 'border (mark)' }))
  select.value = entry.style.shape
  select.title =
    'An element is an extent — a domain — and is drawn as the box it occupies. A border is a ' +
    'point call and is drawn as a mark across the diagonal, which stays visible at any zoom.'
  select.addEventListener('change', () =>
    store.restyle(entry.id, { shape: select.value as 'element' | 'border' }),
  )
  return settingsField('shape', select)
}

/** How big a pair's circle is drawn, in pixels. Moved here for {@link shapeField}'s reason. */
export function radiusField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const input = el('input', {
    class: 'ann-range',
    type: 'range',
    value: String(entry.style.radius),
  })
  input.min = '3'
  input.max = '24'
  input.addEventListener('input', () => store.restyle(entry.id, { radius: Number(input.value) }))
  return settingsField('radius', input)
}

export function opacityField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const input = el('input', {
    class: 'ann-range',
    type: 'range',
    value: String(Math.round(entry.style.opacity * 100)),
  })
  input.min = '10'
  input.max = '100'
  input.addEventListener('input', () => store.restyle(entry.id, { opacity: Number(input.value) / 100 }))
  return settingsField('opacity', input)
}

/**
 * Auto, or a pair of numbers.
 *
 * Auto means *what is in view*, recomputed as the view moves, which is the
 * behaviour a reader expects from a genome browser. The boxes are seeded from
 * the lane's own known range so switching to manual starts somewhere sensible
 * rather than at zero — and seeded through the same trimming the colour clip
 * uses, capped at three decimals. A bigWig header hands back a `float32`
 * widened to a double, so the faithful value of a seed is
 * `0.03999999910593033`, and nothing past the third place of that survives
 * being drawn in a lane forty pixels tall.
 */
export function limitsField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const { limits } = entry.style
  // A barChart has no `fileExtent` — that is filled by the signal readers, and a
  // chart is a feature set — but it does carry the one number that is the same
  // fact: the tallest bar anywhere in the file, which is precisely the ceiling
  // the lane was drawing against before the reader touched this. Seeding from it
  // means leaving auto starts on the picture that was already on screen, rather
  // than on `0 to 1` and a lane of full-height bars (§8.17).
  const seed = entry.fileExtent ?? glyphExtentOfRow(entry) ?? { min: 0, max: 1 }
  const min = el('input', {
    class: 'input input-num',
    type: 'number',
    value: trimNumber(limits.auto ? seed.min : limits.min, 3),
    title: 'Floor of the value axis',
  })
  const max = el('input', {
    class: 'input input-num',
    type: 'number',
    value: trimNumber(limits.auto ? seed.max : limits.max, 3),
    title: 'Ceiling of the value axis',
  })
  /**
   * The mark the colour clip carries, and for the same act.
   *
   * This was the word `auto`, lit while it was on — and the Map card's clip,
   * one panel over, answers the same question with `⇅` *disabled* while auto
   * plus a caption saying what auto chose. Two drawings of "let the data set
   * the range", one lit when on and the other greyed when on, in one column: a
   * reader who learned either one learned nothing about the other. So this row
   * takes the clip's idiom whole (§26.6) — the same mark autoscale wears
   * everywhere, unavailable while there is nothing to go back to, with the pair
   * in force written under the boxes.
   */
  const auto = iconButton('chevrons-up-down', '', () => setAuto(true), {
    class: 'btn btn-icon clip-auto',
    size: 14,
  })
  const note = el('span', { class: 'clip-note' })

  /** Put the row in a state, paint it, and store it. */
  const setAuto = (on: boolean): void => {
    const low = Number(min.value)
    const high = Number(max.value)
    // Refused rather than stored. `resolveLimits` answers an inverted or
    // unreadable pair with `{0, 1}`, so a mistyped bound would redraw the lane
    // against an axis nobody asked for and leave the reader hunting for the
    // number they typed. The box says so and keeps what was there — the same
    // answer the range under the lane's name gives to the same mistake.
    if (!on && (!Number.isFinite(low) || !Number.isFinite(high) || !(high > low))) {
      for (const box of [min, max]) {
        box.classList.add('is-bad')
        window.setTimeout(() => box.classList.remove('is-bad'), 700)
      }
      return
    }
    paintAuto(on, low, high)
    store.restyle(entry.id, { limits: { auto: on, min: low, max: high } })
  }

  /**
   * The mark and the caption, from the state the row is in.
   *
   * Written here rather than left to the rebuild the store change will ask for,
   * because the commonest way to leave auto is to type a bound and press Enter
   * — which leaves the caret in the box, and a rebuild while a control in the
   * list has the caret is deliberately deferred.
   */
  const paintAuto = (on: boolean, low: number, high: number): void => {
    auto.disabled = on
    auto.title = on
      ? 'Back to the data’s own range, which is what this lane is on.'
      : 'Back to the data’s own range, rescaling to what is on screen as the view moves.'
    const pair = `${trimNumber(low, 3)} – ${trimNumber(high, 3)}`
    note.textContent = `${on ? 'auto' : 'clipped'} · ${pair}`
  }

  for (const box of [min, max]) {
    box.step = 'any'
    // Typing a bound *is* leaving auto — there is nothing else the reader could
    // mean by it, and making them clear a tick box first was a step whose only
    // effect was to be forgotten.
    box.addEventListener('change', () => setAuto(false))
  }

  paintAuto(limits.auto, Number(min.value), Number(max.value))

  return el(
    'div',
    {
      class: 'field field-block',
      title:
        'Auto rescales to whatever is on screen, as the view moves. A one-signed track is ' +
        'anchored at zero; a signed one is made symmetric so no change sits in the middle.',
    },
    el('span', { class: 'field-label', text: 'limits' }),
    el('div', { class: 'ann-limits' }, min, max, auto),
    note,
  )
}

// ---------------------------------------------------------------------------
// The alignment lane's own controls (§8.13)
// ---------------------------------------------------------------------------

/**
 * What a colouring means, in the words that go under it.
 *
 * Written out rather than left to the name, because four of the six are only
 * obvious once you already know what they do: `mate` and `pair` sound like the
 * same control, and `insert` sounds like an insertion in a CIGAR when what it
 * colours is the distance between two ends of a template.
 */
const COLOUR_HINTS: Record<ColourBy, string> = {
  strand: 'Forward and reverse, which is the default and the one that costs nothing to read.',
  pair: 'Proper pairs against the ones the aligner could not place as a pair — where discordant reads are.',
  insert: 'Template length: pairs further apart than a normal library are picked out.',
  mate: 'Where the mate went — the same sequence, a different one, or nowhere.',
  mapq: 'Mapping quality, banded, so an ambiguous pile-up is visible as one.',
  basemod:
    'Modified bases from the reads’ MM/ML tags, each at its own position: red where the call is ' +
    'modified, blue where it is not, fainter the less sure the caller was.',
  none: 'One colour, when the point is the shape of the pile rather than the reads in it.',
}

/**
 * The read controls **as the store holds them now**, and the write that follows.
 *
 * Every other control on this card patches one top-level field — `{ size }`,
 * `{ mode }`, `{ limits }` — and lets `restyle` merge it over whatever the store
 * currently has. A nested record cannot do that: writing `{ reads: {...} }`
 * replaces the whole record, so the other four fields come from wherever the
 * caller read them.
 *
 * Read from the *store* rather than from the `entry` the field was built with,
 * because that snapshot goes stale in a way peculiar to this card:
 * `AnnotationCard.render` defers rebuilding while a control holds focus, so
 * after typing in the MAPQ box the row on screen is older than the store. A
 * write built from it silently reverts the reader's previous edit — set a floor
 * of 30, then pick a colouring, and the floor is gone.
 */
function patchReads(
  store: AnnotationStore,
  entry: AnnotationEntry,
  patch: Partial<ReadStyle>,
): void {
  const live = store.byId(entry.id) ?? entry
  store.restyle(entry.id, { reads: { ...readsOf(live.style), ...patch } })
  // …and through to the other row over the same BAM, for the settings that are
  // about which reads *count* rather than how they are drawn (§8.13). A
  // mapping-quality floor on the pile and not on the depth above it is two
  // pictures of two different files under one name.
  const shared: Partial<ReadStyle> = {}
  for (const key of LINKED) if (key in patch) shared[key] = patch[key] as never
  if (Object.keys(shared).length === 0) return
  const other = live.partner === undefined ? undefined : store.byId(live.partner)
  if (other === undefined) return
  store.restyle(other.id, { reads: { ...readsOf(other.style), ...shared } })
}

/**
 * The read settings a BAM's two rows share.
 *
 * Which reads count, and nothing about how they are drawn: a colouring and a
 * pairing describe a pile and mean nothing to a depth curve, and `splits` is
 * deliberately one-sided — see {@link splitsToggle}. Those three are not
 * offered on the depth row at all, so this list is the whole of the link.
 *
 * …and which base modification, at what threshold (§8.13): not about which
 * reads count but about what is *measured* on them, and the pile's marks and
 * the depth's percentage are one measurement read on two rows.
 */
const LINKED = ['minMapq', 'hideDuplicates', 'modCode', 'modThreshold'] as const satisfies ReadonlyArray<keyof ReadStyle>

/** The same, for reading a control's current value back. */
function liveReads(store: AnnotationStore, entry: AnnotationEntry): ReadStyle {
  return readsOf((store.byId(entry.id) ?? entry).style)
}

/**
 * How the pile is coloured.
 *
 * The one control on this lane a reader is expected to reach for often, so it
 * is a select rather than a menu: the six answers are short and the difference
 * between them is the whole reason to look at reads instead of coverage.
 *
 * It refetches. The category each read falls into is decided in the worker and
 * comes back as a column of the pile (`bam/reads.ts`), so a different colouring
 * is a different reply — which is why this lives in the style the caches are
 * keyed on rather than in the renderer.
 *
 * It is a *colouring* and not a grouping: the rows are packed by position
 * alone, so the categories are interleaved down the pile rather than banded.
 * Grouping — a band per category — is a separate thing this lane does not do.
 */
export function colourByField(
  store: AnnotationStore,
  entry: AnnotationEntry,
  onPicked?: (by: ColourBy) => void,
): HTMLElement {
  const reads = readsOf(entry.style)
  const select = el('select', { class: 'select' })
  for (const by of COLOUR_BY) {
    select.appendChild(el('option', { value: by, text: COLOUR_NAMES[by] ?? by, title: COLOUR_HINTS[by] }))
  }
  select.value = reads.colourBy
  select.title = COLOUR_HINTS[reads.colourBy]
  const field = el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'colour by' }),
    select,
  )
  select.addEventListener('change', () => {
    const by = select.value as ColourBy
    select.title = COLOUR_HINTS[by]
    patchReads(store, entry, { colourBy: by })
    // The key is refreshed here rather than left to the card's own rebuild.
    // `AnnotationCard.render` defers while a control holds focus, and picking
    // from a select leaves the focus on it — so the lane repainted in the new
    // colours while the legend under the picker went on naming the old ones,
    // until the reader happened to click somewhere else.
    onPicked?.(by)
  })
  return field
}

/** What a colouring is called in the picker, where its value is not a word. */
const COLOUR_NAMES: Partial<Record<ColourBy, string>> = { basemod: 'base modification' }

/**
 * The key: which colour is which category.
 *
 * Here rather than on the canvas, and that is a decision rather than a
 * shortcut. A legend drawn in the lane has to go somewhere, and every place in
 * an alignment lane is already something — the pile fills it, the coverage band
 * is a curve, the gutter is the name. Drawn in the card it sits directly under
 * the control that decides it, it can be read at any lane height, and it is
 * selectable text rather than pixels.
 *
 * It is built from `groupsFor` and `readPalette` — the same two functions the
 * worker and the renderer use — so it cannot drift from the picture. Nothing
 * about it depends on data being loaded, which is why it is right even while
 * the first window of reads is still being fetched.
 */
export function colourLegend(entry: AnnotationEntry, by?: ColourBy): HTMLElement {
  const host = el('div', { class: 'ann-key' })
  fillLegend(host, entry.style.colour, by ?? readsOf(entry.style).colourBy)
  return host
}

/** Redraw a key in place, for {@link colourByField}'s change handler. */
export function fillLegend(host: HTMLElement, colour: string, by: ColourBy): void {
  // The calls carry the colour under this one, not the reads, so the key is
  // theirs — from the same two inks the lane paints them with.
  if (by === 'basemod') {
    host.replaceChildren(
      ...([
        ['modified', MOD_INK.modified],
        ['unmodified', MOD_INK.unmodified],
        ['fainter: less sure', MOD_INK.read],
      ] as const).map(([name, ink]) =>
        el(
          'span',
          { class: 'ann-key-item' },
          el('span', { class: 'ann-key-chip', style: { background: ink } }),
          el('span', { text: name }),
        ),
      ),
    )
    return
  }
  const groups = groupsFor(by)
  // One category is not a key, it is a restatement of the lane's own colour.
  if (groups.length <= 1) {
    host.replaceChildren()
    return
  }
  const colours = readPalette(groups, colour)
  host.replaceChildren(
    ...groups.map((name, i) =>
      el(
        'span',
        { class: 'ann-key-item' },
        el('span', { class: 'ann-key-chip', style: { background: colours[i] } }),
        el('span', { text: name }),
      ),
    ),
  )
}

/**
 * The mapping-quality floor, in the same shape as the height box.
 *
 * A number rather than a slider or a set of presets, because MAPQ is a number a
 * reader arrives already holding: pipelines are written against 20, 30 or 60,
 * and a control that could not express the one in the protocol would be a
 * control nobody trusted.
 *
 * It changes what is *counted*, not only what is drawn — the coverage band and
 * the depth beside the map move with it — which is the reason it is worth
 * having here rather than as a rendering trick.
 */
export function mapqField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const reads = readsOf(entry.style)
  const box = el('input', {
    class: 'input input-num ann-size',
    type: 'number',
    value: String(reads.minMapq),
    title:
      'Skip alignments below this mapping quality. It changes the depth as well as the pile, ' +
      'so the coverage here agrees with what the reads show. 0 keeps everything.',
  })
  box.min = '0'
  box.max = '255'
  box.step = '1'
  box.addEventListener('change', () => {
    // On the *string*, for the reason `heightField` above gives: `Number('')`
    // is 0. Here the wrong answer is quieter and worse — 0 is a *legal* mapping
    // quality meaning "keep everything", so an emptied box silently turned the
    // filter off and the reader saw more reads rather than an unchanged lane.
    const raw = box.value.trim()
    const typed = raw === '' ? Number.NaN : Math.round(Number(raw))
    if (!Number.isFinite(typed)) {
      box.value = String(liveReads(store, entry).minMapq)
      return
    }
    const clamped = Math.max(0, Math.min(255, typed))
    box.value = String(clamped)
    patchReads(store, entry, { minMapq: clamped })
  })
  return el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'min MAPQ' }),
    box,
  )
}

/**
 * Hide the alignments a pipeline marked as duplicates.
 *
 * A text button rather than an icon, because it has no picture anyone would
 * recognise and it is a state the lane is *in*; it carries `aria-pressed` for
 * the same reason the flip does. It reads as what it *hides* rather than as
 * what it keeps, which is the way round the reader is thinking about it — and
 * it is off by default, on the argument `bam/pile.ts` makes: marking duplicates
 * is a pipeline's decision, and hiding them unasked would make this app
 * disagree with every other reading of the same file.
 *
 * On **both** of a BAM's rows, because it is about which reads count.
 */
export function duplicatesToggle(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const on = readsOf(entry.style).hideDuplicates
  const chip = button(
    'hide duplicates',
    () => patchReads(store, entry, { hideDuplicates: !liveReads(store, entry).hideDuplicates }),
    {
      class: `btn btn-chip${on ? ' is-on' : ''}`,
      title:
        'Skip alignments flagged as PCR or optical duplicates, in the pile and in the depth ' +
        'beside it. Off by default: whether they are marked at all is the pipeline’s decision, ' +
        'not this viewer’s.',
    },
  )
  chip.setAttribute('aria-pressed', String(on))
  return el('div', { class: 'ann-chips' }, chip)
}

/**
 * Draw the further pieces of a read the aligner split across a breakpoint.
 *
 * The pile's alone, and that is the whole asymmetry: a supplementary record is
 * a second piece of one molecule, so drawing it shows a reader where the
 * molecule went and counting it would report one fragment as two. The depth row
 * never sees them however this is set — `pileFilterOf` is the only place in the
 * application that admits one.
 */
export function splitsToggle(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const on = readsOf(entry.style).splits
  const chip = button(
    'split reads',
    () => patchReads(store, entry, { splits: !liveReads(store, entry).splits }),
    {
      class: `btn btn-chip${on ? ' is-on' : ''}`,
      title:
        'Also draw supplementary alignments — the further pieces of a read the aligner had to ' +
        'split across a breakpoint. They are outlined, and they are never counted in the depth.',
    },
  )
  chip.setAttribute('aria-pressed', String(on))
  return el(
    'div',
    { class: 'field field-block' },
    el('span', { class: 'field-label', text: 'reads' }),
    el('div', { class: 'ann-chips' }, chip),
  )
}

/**
 * The sashimi plot's arcs over a BAM's depth, and the fewest reads one is drawn
 * from (§8.23).
 *
 * The depth row's alone. The arcs are drawn over the curve, and the pile beside
 * it draws each spliced read's gap as the line it is. Not written through to
 * the pile for the same reason: it is about how the depth is *drawn*, not about
 * which reads count — a floor on arcs changes no number anywhere.
 */
export function sashimiField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const reads = readsOf(entry.style)
  const chip = button(
    'junction arcs',
    () => patchReads(store, entry, { sashimi: !liveReads(store, entry).sashimi }),
    {
      class: `btn btn-chip${reads.sashimi ? ' is-on' : ''}`,
      title:
        'Draw the introns the reads skip as arcs over the depth — a sashimi plot — each labelled ' +
        'with the reads that skipped it. Counted from the same reads as the depth, under the same ' +
        'filters. Nothing is drawn for a library whose reads are not spliced.',
    },
  )
  chip.setAttribute('aria-pressed', String(reads.sashimi))
  const box = el('input', {
    class: 'input input-num ann-size',
    type: 'number',
    value: String(reads.sashimiFloor),
    title:
      'The fewest reads an arc is drawn from. A junction one read long is as often an ' +
      'aligner’s guess as a splice, and in a deep file those guesses are most of the arcs.',
  })
  box.min = '1'
  box.step = '1'
  box.disabled = !reads.sashimi
  box.addEventListener('change', () => {
    // On the string, as the MAPQ box reads it: an emptied box is no answer,
    // and `Number('')` would be a floor of zero.
    const raw = box.value.trim()
    const typed = raw === '' ? Number.NaN : Math.round(Number(raw))
    if (!Number.isFinite(typed)) {
      box.value = String(liveReads(store, entry).sashimiFloor)
      return
    }
    const clamped = Math.max(1, typed)
    box.value = String(clamped)
    patchReads(store, entry, { sashimiFloor: clamped })
  })
  return el(
    'div',
    { class: 'ann-inline' },
    el('div', { class: 'ann-chips' }, chip),
    el(
      'label',
      { class: 'field ann-field ann-field-tight' },
      el('span', { class: 'field-label', text: 'from' }),
      box,
      el('span', { class: 'field-label', text: 'reads' }),
    ),
  )
}

/**
 * Which base modification, and how sure a call must be (§8.13).
 *
 * On both of a BAM's rows and written through between them: the pile's marks
 * and the depth's percentage are one measurement, and a 5mC pile beside a
 * 5hmC fraction under one file's name would be two modifications read as one.
 *
 * The codes offered are the ones this file's reads have been seen to carry
 * (`ui/modCodes.ts`), behind *most modified in view* — which is
 * what an unset choice resolves to and the right first answer on a file with
 * one modification, the common case. A code chosen and then panned away from
 * stays offered, so the select never loses the value it shows.
 */
export function modField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const reads = readsOf(entry.style)
  const select = el('select', {
    class: 'select',
    title: 'Which modification the calls are drawn for, and the fraction is of.',
  })
  const codesHere = (): string[] => {
    const live = store.byId(entry.id) ?? entry
    const own = modCodesOf(live.id)
    const partner = live.partner === undefined ? [] : modCodesOf(live.partner)
    return [...new Set([...own, ...partner])]
  }
  const fill = (): void => {
    const chosen = liveReads(store, entry).modCode
    const codes = codesHere()
    if (chosen !== '' && !codes.includes(chosen)) codes.push(chosen)
    select.replaceChildren(
      el('option', { value: '', text: 'most modified in view' }),
      ...codes.map((code) => el('option', { value: code, text: modLabel(code) })),
    )
    select.value = chosen
  }
  fill()
  const stop = onModCodes((id) => {
    // A card rebuilt is a new select; the old one's listener goes with it.
    if (!select.isConnected) {
      stop()
      return
    }
    const live = store.byId(entry.id) ?? entry
    if (id !== live.id && id !== live.partner) return
    // Not while it is open or focused: re-filling a select under the reader's
    // hand closes it.
    if (document.activeElement === select) return
    fill()
  })
  select.addEventListener('change', () => patchReads(store, entry, { modCode: select.value }))

  const box = el('input', {
    class: 'input input-num ann-size',
    type: 'number',
    value: String(reads.modThreshold),
    title:
      'How sure a call must be. At or above this it is modified; at or below one minus it, ' +
      'unmodified; between, it is neither drawn nor counted. 0.5 counts every call.',
  })
  box.min = '0.5'
  box.max = '1'
  box.step = '0.05'
  box.addEventListener('change', () => {
    const raw = box.value.trim()
    const typed = raw === '' ? Number.NaN : Number(raw)
    if (!Number.isFinite(typed)) {
      box.value = String(liveReads(store, entry).modThreshold)
      return
    }
    const clamped = Math.max(0.5, Math.min(1, typed))
    box.value = String(clamped)
    patchReads(store, entry, { modThreshold: clamped })
  })
  return el(
    'div',
    { class: 'ann-inline' },
    el(
      'label',
      { class: 'field ann-field ann-field-tight' },
      el('span', { class: 'field-label', text: 'modification' }),
      select,
    ),
    el(
      'label',
      { class: 'field ann-field ann-field-tight' },
      el('span', { class: 'field-label', text: 'p ≥' }),
      box,
    ),
  )
}

/**
 * Draw a BAM's depth row as the percentage of calls modified instead (§8.13,
 * §8.20): a bedMethyl's picture, made from the reads under the same filters
 * as the depth. The depth row's alone, like its arcs — it is about what that
 * row draws — and it brings the modification picker with it, since the
 * percentage is of one code.
 */
export function modFractionField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const on = readsOf(entry.style).modFraction
  const chip = button(
    '% modified',
    () => patchReads(store, entry, { modFraction: !liveReads(store, entry).modFraction }),
    {
      class: `btn btn-chip${on ? ' is-on' : ''}`,
      title:
        'Draw this row as the percentage of the reads’ modification calls that are modified, at ' +
        'each base — what a bedMethyl from modkit would show — instead of depth. From the MM/ML ' +
        'tags; nothing is drawn for a file without them.',
    },
  )
  chip.setAttribute('aria-pressed', String(on))
  const block = el(
    'div',
    { class: 'field field-block' },
    el('span', { class: 'field-label', text: 'base modifications' }),
    el('div', { class: 'ann-chips' }, chip),
  )
  return on ? el('div', { class: 'ann-mods' }, block, modField(store, entry)) : block
}

/**
 * How the two ends of a template are laid out.
 *
 * A select rather than a switch, because it is three answers and not two — and
 * because which one a reader wants is a property of their library, not a thing
 * they toggle back and forth. Paired is the default: it is what a paired-end
 * file is, and drawing the two ends on separate rows joined by nothing made a
 * fragment read as two unrelated reads.
 */
const LAYOUT_HINTS: Record<PairLayout, string> = {
  pairs:
    'Both ends of a template on one row, joined by a dotted thread across the part that was not ' +
    'sequenced. The default, and what a paired-end library is.',
  fragments:
    'The whole template as one bar, gap filled. For reading fragment coverage rather than reads.',
  reads:
    'Every record packed on its own, mates unjoined. What a single-ended library wants.',
}

export function layoutField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const reads = readsOf(entry.style)
  const select = el('select', { class: 'select' })
  for (const mode of PAIR_LAYOUTS) {
    select.appendChild(el('option', { value: mode, text: mode, title: LAYOUT_HINTS[mode] }))
  }
  select.value = reads.layout
  select.title = LAYOUT_HINTS[reads.layout]
  select.addEventListener('change', () => {
    const mode = select.value as PairLayout
    select.title = LAYOUT_HINTS[mode]
    patchReads(store, entry, { layout: mode })
  })
  return el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'draw as' }),
    select,
  )
}

// ---------------------------------------------------------------------------
// The controls a lane of intervals has (§8.16)
// ---------------------------------------------------------------------------

/**
 * The feature controls **as the store holds them now**, and the write after it.
 *
 * `patchReads`' twin, and it is a separate function for the one reason that
 * matters: a nested record cannot be merged by `restyle`, so writing
 * `{ features: {...} }` replaces the whole record and the other field has to
 * come from somewhere. It comes from the *store* rather than from the `entry`
 * the control was built with, because `AnnotationCard.render` defers rebuilding
 * while a control holds focus — so after picking a colouring the row on screen
 * is older than the store, and a write built from it would silently undo the
 * reader's previous edit.
 *
 * Nothing is written through to a partner row, which is the whole difference
 * from `patchReads`: these are about how one lane is *drawn*, and a feature set
 * has no second row drawn from the same bytes.
 */
export function patchFeatures(
  store: AnnotationStore,
  entry: AnnotationEntry,
  patch: Partial<FeatureStyle>,
): void {
  const live = store.byId(entry.id) ?? entry
  store.restyle(entry.id, { features: { ...featuresOf(live.style, live.kind), ...patch } })
}

/** The set behind a row, or `undefined` while the worker is still parsing it. */
function setOf(entry: AnnotationEntry): FeatureSet | undefined {
  return entry.payload?.kind === 'features' ? entry.payload.data : undefined
}

/**
 * Which column the segments take their colour from.
 *
 * A select, and a long one, because the answers are the *file's* — `source`,
 * `biotype`, `signal`, `filter` — and the reader recognises the one they want
 * by name rather than choosing between four fixed pictures. What is offered
 * comes from `annotations/fields.ts`, which reads the keys back out of the
 * detail strings the parsers wrote, so nothing here has to know that a GTF has
 * biotypes and a narrowPeak has q-values.
 *
 * Unlike an alignment lane's colouring this one **refetches nothing**. A
 * feature set is in memory whole, the field is a column of it, and the change is
 * a repaint — which is why the picker can offer a dozen answers without any of
 * them costing a read.
 *
 * The lane's own strand is first and is where every one of these lanes starts.
 * A choice whose column the file no longer carries is kept rather than
 * corrected: the same session opened against the other half of an experiment
 * should colour by `biotype` again when the GTF comes back, and the picker shows
 * it as missing rather than quietly moving the reader somewhere else.
 */
export function featureColourField(
  store: AnnotationStore,
  entry: AnnotationEntry,
  onPicked?: (by: string) => void,
): HTMLElement {
  const style = featuresOf(entry.style, entry.kind)
  const fields = featureFields(setOf(entry), entry.kind)
  const select = el('select', { class: 'select' })
  for (const field of fields) {
    select.appendChild(el('option', { value: field.key, text: field.label, title: field.hint }))
  }
  if (fieldFor(fields, style.colourBy) === null) {
    // A column this file does not have — a session from another assembly, or a
    // row still loading. Shown as itself and marked, so the reader can see what
    // the choice *was* rather than watching it silently become something else.
    select.appendChild(
      el('option', {
        value: style.colourBy,
        text: `${style.colourBy} (not in this file)`,
        title: 'Stored from another file. It comes back the moment a file carrying the column is loaded into this row.',
      }),
    )
  }
  select.value = style.colourBy
  select.title = fieldFor(fields, style.colourBy)?.hint ?? ''
  select.addEventListener('change', () => {
    const by = select.value
    select.title = fieldFor(fields, by)?.hint ?? ''
    patchFeatures(store, entry, { colourBy: by })
    // Refreshed here rather than left to the card's own rebuild: picking from a
    // select leaves the focus on it, the card defers while a control has focus,
    // and the lane does not — so the key under the picker would go on naming
    // the old colours until the reader happened to click somewhere else.
    onPicked?.(by)
  })
  return el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'colour by' }),
    select,
  )
}

/**
 * What each way of spending a feature lane's rows is called, and what it does
 * (§8.16) — one table for the card's picker and the lane's right-click menu, so
 * the two cannot come to call one mode by two names.
 */
export const FEATURE_DISPLAY_WORDS: Record<FeatureDisplay, { label: string; hint: string }> = {
  expanded: {
    label: 'expanded',
    hint: 'A row for each overlapping feature, with room under it for its name.',
  },
  squished: {
    label: 'squished',
    hint: 'Thin rows and no names, so a crowded stretch shows every feature in it.',
  },
  collapsed: {
    label: 'collapsed',
    hint: 'One row across the whole lane, overlapping features drawn over each other.',
  },
}

/**
 * How the lane spends its rows: expanded, squished or collapsed (§8.16).
 *
 * A select rather than three chips, for the reason the colour picker beside it
 * is one: three words side by side in a card this narrow wrap, and a wrapped
 * group of chips reads as two groups.
 */
export function featureDisplayField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const display = featuresOf(entry.style, entry.kind).display
  const select = el('select', { class: 'select' })
  for (const one of FEATURE_DISPLAYS) {
    const words = FEATURE_DISPLAY_WORDS[one]
    select.appendChild(el('option', { value: one, text: words.label, title: words.hint }))
  }
  select.value = display
  select.title = FEATURE_DISPLAY_WORDS[display].hint
  select.addEventListener('change', () => {
    const picked = FEATURE_DISPLAYS.find((one) => one === select.value) ?? display
    select.title = FEATURE_DISPLAY_WORDS[picked].hint
    patchFeatures(store, entry, { display: picked })
  })
  return el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'rows' }),
    select,
  )
}

/**
 * Point the stranded features the way they run.
 *
 * A switch rather than a setting with three answers, because there are two: a
 * lane where the direction is worth a glyph and one where it is not. It changes
 * nothing about features the file gives no strand, which is why it is offered on
 * every interval lane rather than only on the stranded ones — a peak set that
 * turns out to carry strands should not need its settings re-read to say so.
 */
export function arrowsToggle(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const on = featuresOf(entry.style, entry.kind).arrows
  const chip = button(
    'point strands',
    () =>
      patchFeatures(store, entry, {
        arrows: !featuresOf((store.byId(entry.id) ?? entry).style, entry.kind).arrows,
      }),
    {
      class: `btn btn-chip${on ? ' is-on' : ''}`,
      title:
        'End every feature the file gives a strand in a point, on the end it runs to — a ' +
        'transcript’s last exon. The glyph keeps the feature’s exact extent either way.',
    },
  )
  chip.setAttribute('aria-pressed', String(on))
  return el('div', { class: 'ann-chips' }, chip)
}

/**
 * What a barChart's bars are measured against (§8.17).
 *
 * The one control a barChart lane has, and it is here because the two readings
 * it switches between are both right and neither can be guessed from the file.
 * Against the **file's** ceiling a tall bar means a big number anywhere on the
 * lane, which is what makes two glyphs comparable and is the default. Against
 * each feature's **own** top every chart is a shape — which condition wins, and
 * by how much against the rest of that feature — and that is the only reading
 * a heavy-tailed file has: expression runs over three orders of magnitude, so
 * one ceiling draws the whole lane flat except for the handful of genes a
 * reader did not need a chart to find.
 *
 * A switch and not a heuristic on the distribution, because a lane that quietly
 * changed what its heights meant when a file's tail got longer would be the
 * worst version of both.
 */
export function barScaleToggle(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const per = featuresOf(entry.style, entry.kind).bars === 'feature'
  const chip = button(
    'scale each chart',
    () =>
      patchFeatures(store, entry, {
        bars:
          featuresOf((store.byId(entry.id) ?? entry).style, entry.kind).bars === 'feature'
            ? 'file'
            : 'feature',
      }),
    {
      class: `btn btn-chip${per ? ' is-on' : ''}`,
      title:
        'Measure every chart against its own tallest bar instead of against one ceiling for the ' +
        'whole file. Each feature becomes a shape — which category wins, and by how much — at the ' +
        'cost of being able to compare two features by height.',
    },
  )
  chip.setAttribute('aria-pressed', String(per))
  return el('div', { class: 'ann-chips' }, chip)
}

/**
 * Which colour is which value, under the control that decides it.
 *
 * In the card rather than on the canvas, for §8.13's reason and one more of its
 * own: a feature lane can be sixteen pixels tall beside a map, which is not a
 * legend's worth of room at any font. Built from `featureColouring` — the
 * function the renderer itself calls — so a key that disagreed with the picture
 * would be a bug in the ink rule rather than a second palette drifting out of
 * step.
 *
 * A numeric column gets a ramp with its two ends written on it instead of a row
 * of chips, because a hundred thousand p-values have no categories to name and
 * the only two numbers worth printing are the ones the ramp runs between.
 */
export function featureLegend(entry: AnnotationEntry, store?: AnnotationStore): HTMLElement {
  const host = el('div', { class: 'ann-key' })
  fillFeatureLegend(host, entry, undefined, store)
  return host
}

/** Redraw a key in place, for {@link featureColourField}'s change handler. */
export function fillFeatureLegend(
  host: HTMLElement,
  entry: AnnotationEntry,
  by?: string,
  /**
   * Where given, a name's chip is a colour picker (§8.16): the colour is
   * written to the row's `nameColours`, the one mapping a model coloured by
   * this set's names reads too (§25.5).
   */
  store?: AnnotationStore,
): void {
  const style = featuresOf(entry.style, entry.kind)
  const { key } = featureColouring(
    setOf(entry),
    entry.kind,
    by ?? style.colourBy,
    entry.style.colour,
    style.nameColours,
  )
  if (key.ramp !== null) {
    host.replaceChildren(
      el('span', { class: 'ann-key-end', text: trimNumber(key.ramp.min) }),
      el('span', {
        class: 'ann-key-ramp',
        style: { background: `linear-gradient(to right, ${rampStops().join(', ')})` },
      }),
      el('span', { class: 'ann-key-end', text: trimNumber(key.ramp.max) }),
    )
    return
  }
  // One chip is not a key, it is a restatement of the lane's own colour —
  // except a name's, which is a control.
  if (key.levels.length === 0 || (key.levels.length === 1 && key.field.kind !== 'name')) {
    host.replaceChildren()
    return
  }
  host.replaceChildren(
    ...key.levels.map((level) => {
      const name = level.name
      if (store === undefined || name === undefined) {
        return el(
          'span',
          { class: 'ann-key-item' },
          el('span', { class: 'ann-key-chip', style: { background: level.colour } }),
          el('span', { text: level.label }),
        )
      }
      const swatch = el('input', {
        class: 'ann-key-swatch',
        type: 'color',
        value: level.colour,
        title: `Colour for ${level.label}, on this lane and on a model coloured by these names`,
      })
      swatch.addEventListener('input', () => {
        const live = store.byId(entry.id) ?? entry
        const held = featuresOf(live.style, live.kind).nameColours ?? {}
        patchFeatures(store, live, { nameColours: { ...held, [name]: swatch.value } })
      })
      return el('label', { class: 'ann-key-item' }, swatch, el('span', { text: level.label }))
    }),
  )
}

/**
 * A sequence lane's six reading frames, and the genetic code they are read in
 * (§8.8).
 *
 * A chip for the frames, for the reason the alignment lane's switches are chips:
 * it is a state the lane is in and has no picture anyone would recognise. The
 * code beside it is a select of NCBI's tables by number and name — the number
 * is what a GenBank file's `transl_table` says, so it is what a reader will be
 * looking for — and stays live with the frames off, since the code is a fact
 * about the genome and not about whether its frames are on screen.
 *
 * Drawn wherever the lane draws residues: the 1D browser and a deck's tracks
 * cells. Beside a map the lane is GC content and has no codons to show.
 */
export function framesField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const live = (): TranslationStyle =>
    translationOf(store.entries.find((each) => each.id === entry.id)?.style ?? entry.style)
  const on = translationOf(entry.style).frames
  const select = el('select', {
    class: 'select',
    title:
      'The genetic code the frames are read in — NCBI’s translation tables. 4 for Mycoplasma and ' +
      'Spiroplasma, where TGA is tryptophan; 11 for bacteria, archaea and plastids; 2 for a ' +
      'vertebrate mitochondrion.',
  })
  for (const code of GENETIC_CODES) {
    select.appendChild(el('option', { value: String(code.id), text: `${code.id} · ${code.name}` }))
  }
  select.value = String(translationOf(entry.style).code)
  select.addEventListener('change', () => {
    store.restyle(entry.id, { translation: { ...live(), code: Number(select.value) } })
  })
  const chip = button(
    'reading frames',
    () => {
      const next = !live().frames
      store.restyle(entry.id, { translation: { ...live(), frames: next } })
      // Here as well as on the card's rebuild, which waits while a control
      // holds focus — and this one does, having just been pressed.
      chip.classList.toggle('is-on', next)
      chip.setAttribute('aria-pressed', String(next))
    },
    {
      class: `btn btn-chip${on ? ' is-on' : ''}`,
      title:
        'Six rows under the sequence: the codons of frames +1, +2, +3 and of −1, −2, −3 on the ' +
        'other strand, each with its amino acid where it fits, starts in green and stops in red. ' +
        'Further out, the starts and stops alone. In the 1D browser and a deck’s tracks cells.',
    },
  )
  chip.setAttribute('aria-pressed', String(on))
  return el(
    'div',
    { class: 'ann-inline' },
    el('div', { class: 'ann-chips' }, chip),
    el(
      'label',
      { class: 'field ann-field ann-field-tight' },
      el('span', { class: 'field-label', text: 'code' }),
      select,
    ),
  )
}
