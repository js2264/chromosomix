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
  COLOUR_BY,
  PAIR_LAYOUTS,
  TRACK_SCALES,
  readsOf,
  scaleOf,
  type AnnotationEntry,
  type ColourBy,
  type PairLayout,
  type ReadStyle,
  type TrackScale,
} from '../annotations/types'
import { groupsFor } from '../annotations/bam/reads'
import { readPalette } from '../render/alignments'
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

/** Line, area or bars — how a value profile is resolved into ink. */
export function modeField(store: AnnotationStore, entry: AnnotationEntry): HTMLElement {
  const select = el('select', { class: 'select' })
  for (const mode of ['area', 'line', 'bar'] as const) {
    select.appendChild(el('option', { value: mode, text: mode }))
  }
  select.value = entry.style.mode
  select.addEventListener('change', () =>
    store.restyle(entry.id, { mode: select.value as 'area' | 'line' | 'bar' }),
  )
  return el(
    'label',
    { class: 'field ann-field ann-field-tight' },
    el('span', { class: 'field-label', text: 'style' }),
    select,
  )
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
  const seed = entry.fileExtent ?? { min: 0, max: 1 }
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
   * A toggle button, not a tick box.
   *
   * The tick box was a third control on a row that already held two number
   * boxes, and it took the width that made them overflow. A button carries its
   * state in its own border, needs no label beside it, and — unlike a tick box
   * — reads as the thing to press to *get back* to auto, which is the only
   * direction it is ever pressed in: leaving auto happens by typing a bound.
   */
  const auto = button('auto', () => setAuto(!auto.classList.contains('is-on')), {
    class: 'btn btn-quiet ann-auto',
  })

  /**
   * Put the button in a state, and store it.
   *
   * The button is repainted *here* rather than left to the rebuild the store
   * change will ask for, because the commonest way to leave auto is to type a
   * bound and press Enter — which leaves the caret in the box, and a rebuild
   * while a control in the list has the caret is deliberately deferred. Without
   * this the reader types a limit, sees the lane rescale, and is still looking
   * at a button that says it is on auto.
   */
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
    auto.classList.toggle('is-on', on)
    auto.setAttribute('aria-pressed', String(on))
    auto.title = on
      ? 'Rescaling to what is on screen. Type a bound, or press this, to fix the range.'
      : 'Fixed to the pair beside this. Press to rescale to what is on screen instead.'
    store.restyle(entry.id, { limits: { auto: on, min: low, max: high } })
  }

  for (const box of [min, max]) {
    box.step = 'any'
    // Typing a bound *is* leaving auto — there is nothing else the reader could
    // mean by it, and making them clear a tick box first was a step whose only
    // effect was to be forgotten.
    box.addEventListener('change', () => setAuto(false))
  }

  auto.classList.toggle('is-on', limits.auto)
  auto.setAttribute('aria-pressed', String(limits.auto))
  auto.title = limits.auto
    ? 'Rescaling to what is on screen. Type a bound, or press this, to fix the range.'
    : 'Fixed to the pair beside this. Press to rescale to what is on screen instead.'

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
 */
const LINKED = ['minMapq', 'hideDuplicates'] as const satisfies ReadonlyArray<keyof ReadStyle>

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
    select.appendChild(el('option', { value: by, text: by, title: COLOUR_HINTS[by] }))
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
