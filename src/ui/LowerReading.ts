/**
 * The lower triangle of one map, read another way (§5.10).
 *
 * A contact matrix is symmetric, so the half of the square below the diagonal is
 * a mirror carrying nothing. §5.7 gives that half to a second file; this gives
 * it to a **second reading of the same file** — its own score, its own
 * smoothing, its own O/E and its own colour scale — so balanced counts above the
 * diagonal and their O/E below it, or raw counts against a despeckled map, are
 * one picture read against itself at every position.
 *
 * Everything about *where* the picture is — the window, the resolution, the
 * turn, the overlays, the tracks — is the map's and is not here. What is here is
 * the half of the panel's state that a second reading needs a copy of: the
 * derivation and its jobs (`ui/MapDerivation.ts`, a second instance), the colour
 * scale with the hand-over a diverging derivation makes of it (§7.5), and the
 * controls of the Map card's second tab. The panel owns the block, the merge
 * across the diagonal, the renderer and the keys, and asks this for the numbers
 * and the scale.
 */

import type { DerivedValues } from '../render/derive'
import { preferredTransform } from '../render/derive'
import { formatCount, keyContent, keyTitle, type KeyContent } from '../render/legend'
import { inverseTransform } from '../render/scale'
import { SMOOTH_CHOICES } from '../render/smooth'
import {
  COLORMAP_NAMES,
  COLOR_VISION_SAFE_COLORMAPS,
  DEFAULT_DIVERGING_COLORMAP,
  isDivergingColormap,
} from '../render/colormaps'
import type { ColorScale, Transform } from '../types'
import type { MatrixResult } from '../worker/protocol'
import { armsKey } from './armFrame'
import { ClipRange } from './ClipRange'
import { el, field, trimNumber } from './dom'
import { MapDerivation } from './MapDerivation'
import type { DerivePresentation, MatrixPanelOptions } from './MatrixPanel'
import type { ScoreChoice } from './scores'

/** A colour scale as the link holds it: absent bounds are auto. */
export interface LowerScale {
  transform: Transform
  colormap: string
  vmin?: number
  vmax?: number
}

/**
 * What the reading above the diagonal is now, for a lower reading nobody has
 * set to start from — so switching it on changes nothing on screen until one
 * of its fields does. The scale is the one the map would be drawn on with
 * nothing derived, which is what a derivation switched on under it borrows from.
 */
export interface LowerSeed extends LowerScale {
  score: string
  oe: boolean
  smooth: string
}

/** The lower reading as the session hands it to a map. */
export interface LowerPresentation {
  /** Whether the lower triangle is drawn in it; off, the map is symmetric as ever. */
  on: boolean
  /** Whether any of it has been written down; a first switch-on is seeded. */
  set: boolean
  onToggle(on: boolean, seed: LowerSeed): void
  /** Its score picker: the upper's own list. */
  scores: { choices: readonly ScoreChoice[]; current: string; onChange(choice: ScoreChoice): void }
  /** What its cells are derived by; `arms` is the map's, applied without a control of its own. */
  derive: DerivePresentation
  /** Its colour scale, as the state holds it. */
  scale: LowerScale
  onScaleChange(scale: LowerScale): void
  /** Whether its cells are multiplied by their bin weights, which is what `log10` reads zero by. */
  balance: boolean
  /**
   * The read it needs where that is not the block the upper reading is drawn
   * from — another `/pixels` column, or the balancing the other way — else
   * `null`. A map handed no such block draws one reading over the whole square
   * rather than the upper's numbers under the lower's name.
   */
  read: { balance: boolean; value?: string } | null
}

/** What the reading needs of the panel it is half of. */
export interface LowerHost {
  /** The panel's options, held by reference: `lower` and `binsize` move under it. */
  readonly options: MatrixPanelOptions
  /** Veil the map, or take the veil down: the panel's own, shared with the upper's jobs. */
  setBusy(busy: boolean, message?: string): void
  /** A job of this reading's has landed: derive the block in hand again. */
  redraw(): void
  /** The scale moved and the numbers did not: hand the renderer the new layer. */
  rescaled(): void
  /** The upper reading as it is now; see {@link LowerSeed}. */
  seed(): LowerSeed
  /** What the map is drawn on with nothing set (§7.1), which a link landing on a diverging scale gives back. */
  defaults(): { transform: Transform; colormap: string } | undefined
}

const TRANSFORMS: Transform[] = ['log1p', 'log10', 'log2', 'none']

const SWITCH_HINT =
  'Draw the triangle below the diagonal in a reading of its own: its own score, smoothing, O/E and colours. ' +
  'Off leaves it the mirror of the one above.'

const OE_HINT =
  'Observed over expected, below the diagonal alone: each cell divided by what its genomic distance predicts.'

const OE_ON_BASELINE_HINT =
  'The cells below the diagonal already are the expected values. Choose another score to get the toggle back.'

/**
 * Which tab of the Map card is open, kept for the panel built next.
 *
 * Every navigation builds the map again, and a reader setting the lower
 * triangle and then going to the next chromosome would otherwise be put back on
 * the first tab each time — away from the fields they were in the middle of.
 */
let openTab: 'map' | 'lower' = 'map'

/** The tab the card opens on; see {@link openTab}. */
export function lastMapTab(): 'map' | 'lower' {
  return openTab
}

/** Remember the tab the reader chose. */
export function rememberMapTab(tab: 'map' | 'lower'): void {
  openTab = tab
}

export class LowerReading {
  /** The second tab's contents: the switch and, while it is on, the fields. */
  readonly pane: HTMLElement
  /** This reading's own derivation and jobs, a second instance of the upper's. */
  readonly derivation: MapDerivation
  transform: Transform
  colormap: string
  manualVmin: number | undefined
  manualVmax: number | undefined
  /** The neutral value of what is drawn below the diagonal, or `null` for a count field. */
  neutral: number | null = null
  /** The values derived for the lower triangle, the whole square of them. */
  derived: DerivedValues | null = null

  /** What a diverging derivation took over, and gives back (§7.5); the upper's rule, kept apart. */
  private divergingRestore: LowerScale | null = null
  private divergingApplied: Transform | null = null
  /** Whether the scale is still the one this reading was built with; see the panel's `freshSeed`. */
  private freshSeed = true

  private readonly host: LowerHost
  private readonly switchButton: HTMLButtonElement
  private readonly fields: HTMLElement
  /** What switching on does, while it is off: the empty tab's one line. */
  private readonly offNote: HTMLElement
  private readonly scoreSelect: HTMLSelectElement
  private readonly smoothSelect: HTMLSelectElement
  private readonly oeButton: HTMLButtonElement
  private readonly transformSelect: HTMLSelectElement
  private readonly colormapSelect: HTMLSelectElement
  private readonly clipLabel: HTMLElement
  readonly clip: ClipRange

  constructor(host: LowerHost) {
    this.host = host
    // The options a derivation reads, as this reading has them: the panel's bin
    // size, and this reading's own recipe in the slot the upper's is read from.
    // Getters, because both move under a mounted map.
    const options = {
      get binsize(): number {
        return host.options.binsize
      },
      get derive(): DerivePresentation | undefined {
        return host.options.lower?.derive
      },
    }
    this.derivation = new MapDerivation({
      options,
      setBusy: (busy, message) => host.setBusy(busy, message),
      redraw: () => host.redraw(),
    })
    const scale = host.options.lower?.scale
    this.transform = scale?.transform ?? 'log1p'
    this.colormap = scale?.colormap ?? DEFAULT_DIVERGING_COLORMAP
    this.manualVmin = scale?.vmin
    this.manualVmax = scale?.vmax

    const labelId = `lower-switch-${Math.random().toString(36).slice(2, 8)}`
    this.switchButton = el('button', {
      class: 'btn btn-toggle',
      type: 'button',
      text: 'on',
      title: SWITCH_HINT,
    })
    this.switchButton.setAttribute('aria-labelledby', labelId)
    this.switchButton.addEventListener('click', () => {
      const held = this.host.options.lower
      if (held === undefined) return
      held.onToggle(!held.on, this.host.seed())
    })

    this.scoreSelect = el('select', { class: 'select' })
    this.scoreSelect.addEventListener('change', () => {
      const scores = this.host.options.lower?.scores
      const picked = scores?.choices.find((choice) => choice.id === this.scoreSelect.value)
      if (picked !== undefined) scores?.onChange(picked)
    })

    this.smoothSelect = el('select', { class: 'select' })
    for (const choice of SMOOTH_CHOICES) {
      this.smoothSelect.appendChild(el('option', { value: choice.id, text: choice.label }))
    }
    this.smoothSelect.addEventListener('change', () => {
      this.host.options.lower?.derive.onSmoothChange?.(this.smoothSelect.value)
    })

    this.oeButton = el('button', {
      class: 'btn btn-icon btn-toggle btn-word',
      title: OE_HINT,
      attrs: { type: 'button', 'aria-label': OE_HINT },
    })
    this.oeButton.append(el('span', { class: 'btn-word-text', text: 'O/E' }))
    this.oeButton.addEventListener('click', () => {
      const derive = this.host.options.lower?.derive
      derive?.onExpectedChange?.(derive.expected !== true)
    })

    this.transformSelect = el('select', { class: 'select' })
    for (const name of TRANSFORMS) this.transformSelect.appendChild(el('option', { value: name, text: name }))
    this.transformSelect.addEventListener('change', () => {
      this.transform = this.transformSelect.value as Transform
      // A clip is in transformed units, so it does not survive a change of
      // transform — the upper's rule, for the upper's reason.
      this.manualVmin = undefined
      this.manualVmax = undefined
      this.rescale()
    })

    this.colormapSelect = el('select', { class: 'select' })
    for (const name of COLORMAP_NAMES) {
      const safe = COLOR_VISION_SAFE_COLORMAPS.includes(name)
      this.colormapSelect.appendChild(el('option', { value: name, text: safe ? `${name} ✓` : name }))
    }
    this.colormapSelect.title = 'A ✓ marks a colour-vision-safe map.'
    this.colormapSelect.addEventListener('change', () => {
      this.colormap = this.colormapSelect.value
      this.rescale()
    })

    this.clipLabel = el('span', { class: 'field-label' })
    this.clip = new ClipRange({
      onChange: (clip) => {
        this.manualVmin = clip?.vmin
        this.manualVmax = clip?.vmax
        this.rescale()
      },
      format: (value) => formatCount(inverseTransform(value, this.transform)),
      // What the numbers are once derived — `0.69 – 1.45 O/E` — since under a
      // ratio the score's own word names the operand and not the value.
      unit: () => this.derivedLabel() ?? this.scoreWord(),
    })

    this.fields = el(
      'div',
      { class: 'map-lower-fields' },
      field(
        'score',
        this.scoreSelect,
        'What the cells below the diagonal are: the same list as the map’s, chosen for this triangle alone.',
      ),
      field(
        'smooth',
        this.smoothSelect,
        'Average each cell below the diagonal with the cells around it. Adaptive turns this triangle’s O/E on.',
      ),
      field('baseline', this.oeButton, OE_HINT),
      field('transform', this.transformSelect, 'How a value below the diagonal becomes a colour.'),
      field('colours', this.colormapSelect, 'The ramp below the diagonal; a ✓ marks a colour-vision-safe one.'),
      el(
        'div',
        { class: 'field field-clip', title: 'Where the ramp below the diagonal starts and saturates.' },
        this.clipLabel,
        this.clip.el,
      ),
    )
    this.offNote = el('p', {
      class: 'hint map-lower-note',
      text: 'Switch it on to give the triangle below the diagonal its own score, smoothing, O/E and colours.',
    })
    this.pane = el(
      'div',
      { class: 'panel-controls map-lower' },
      el(
        'div',
        { class: 'field', title: SWITCH_HINT },
        el('span', { class: 'field-label', id: labelId, text: 'own reading' }),
        this.switchButton,
      ),
      this.offNote,
      this.fields,
    )
    this.paint()
  }

  /** The presentation as the panel holds it now. */
  private get presentation(): LowerPresentation | undefined {
    return this.host.options.lower
  }

  /**
   * Whether the lower triangle is drawn in this reading: offered, switched on,
   * and handed the block it reads — the upper's own, or the second read its
   * score asked for.
   */
  inForce(second: MatrixResult | undefined): boolean {
    const held = this.presentation
    return held !== undefined && held.on && (held.read === null || second !== undefined)
  }

  /** The block this reading is derived from: the second read where it needed one. */
  operand(data: MatrixResult, second: MatrixResult | undefined): MatrixResult {
    return this.presentation?.read === null || second === undefined ? data : second
  }

  /**
   * Derive the lower triangle's values, the whole square of them.
   *
   * @returns whether the scale was handed over or back on the way, which the
   *   panel announces once the block is in.
   */
  derive(block: MatrixResult): boolean {
    const { mine } = this.derivation.derive(block, undefined)
    this.derived = mine
    this.neutral = mine.neutral
    return this.syncDivergingScale()
  }

  /** Put the reading down: nothing is derived for it until it is in force again. */
  clear(): void {
    this.derived = null
    this.neutral = null
  }

  /** The colour scale below the diagonal; an unclipped bound is `NaN`, as the upper's is. */
  scale(): ColorScale {
    return {
      vmin: this.manualVmin ?? Number.NaN,
      vmax: this.manualVmax ?? Number.NaN,
      transform: this.transform,
      colormap: this.colormap,
      balanced: this.presentation?.balance === true,
      ...(this.neutral === null ? {} : { neutral: this.neutral }),
    }
  }

  /** The scale with nothing derived: what a link should carry as this reading's own. */
  private announced(): LowerScale {
    return {
      transform: this.transform,
      colormap: this.colormap,
      ...(this.manualVmin === undefined ? {} : { vmin: this.manualVmin }),
      ...(this.manualVmax === undefined ? {} : { vmax: this.manualVmax }),
    }
  }

  /** Tell the session the scale moved, so the link follows it. */
  announce(): void {
    this.presentation?.onScaleChange(this.announced())
  }

  /**
   * A bound typed in the second key: the clip boxes' change, from the corner of
   * the map.
   */
  setBound(bound: 'lo' | 'hi', value: number | null): void {
    if (bound === 'lo') this.manualVmin = value ?? undefined
    else this.manualVmax = value ?? undefined
    this.rescale()
  }

  private rescale(): void {
    this.freshSeed = false
    this.paintClipUnits()
    this.announce()
    this.host.rescaled()
  }

  /**
   * Hand the scale to a diverging field below the diagonal, or hand it back —
   * the panel's `syncDivergingScale`, for this triangle alone (§7.5).
   */
  private syncDivergingScale(): boolean {
    const wanted = preferredTransform(this.neutral)
    const fresh = this.freshSeed
    this.freshSeed = false
    if (wanted === this.divergingApplied) return false
    if (wanted === null) {
      const back = this.divergingRestore
      this.divergingRestore = null
      this.divergingApplied = null
      if (back === null) return false
      this.transform = back.transform
      this.colormap = back.colormap
      this.manualVmin = back.vmin
      this.manualVmax = back.vmax
      this.paint()
      return true
    }
    const defaults = this.host.defaults()
    // A link, a reload or Back that lands on the derived scale already: its clip
    // is in the derived units and is the reader's, so it stays — only a clip
    // measured in counts has no reading in ratios.
    const landed = fresh && this.transform === wanted && isDivergingColormap(this.colormap)
    this.divergingRestore ??=
      landed && defaults !== undefined
        ? { transform: defaults.transform, colormap: defaults.colormap }
        : this.announced()
    this.transform = wanted
    if (!isDivergingColormap(this.colormap)) this.colormap = DEFAULT_DIVERGING_COLORMAP
    if (!landed) {
      this.manualVmin = undefined
      this.manualVmax = undefined
    }
    this.divergingApplied = wanted
    this.paint()
    return true
  }

  /**
   * Take a presentation that came from outside — a render of the session, a
   * link, Back — and show it, without echoing it out again.
   *
   * @returns whether what is *derived* is unchanged: the switch, the score, the
   *   O/E, the despeckle and the read. A change of colours alone is a repaint.
   */
  sync(next: LowerPresentation | undefined, held: LowerPresentation | undefined): boolean {
    const same =
      (held?.on === true) === (next?.on === true) &&
      held?.scores.current === next?.scores.current &&
      held?.derive.normalise === next?.derive.normalise &&
      (held?.derive.expected === true) === (next?.derive.expected === true) &&
      (held?.derive.smooth ?? '0') === (next?.derive.smooth ?? '0') &&
      (held?.derive.correlate === true) === (next?.derive.correlate === true) &&
      (held?.derive.baseline === true) === (next?.derive.baseline === true) &&
      (held?.derive.alongArms === true) === (next?.derive.alongArms === true) &&
      armsKey(held?.derive.arms) === armsKey(next?.derive.arms) &&
      held?.read?.balance === next?.read?.balance &&
      held?.read?.value === next?.read?.value
    if (next !== undefined) {
      this.transform = next.scale.transform
      this.colormap = next.scale.colormap
      this.manualVmin = next.scale.vmin
      this.manualVmax = next.scale.vmax
    }
    this.paint()
    return same
  }

  /** Put the presentation and the scale on the controls; no `change` fires from here. */
  paint(): void {
    const held = this.presentation
    const on = held?.on === true
    this.switchButton.setAttribute('aria-pressed', String(on))
    this.fields.classList.toggle('hidden', !on)
    this.offNote.classList.toggle('hidden', on)
    if (held !== undefined) {
      const ids = held.scores.choices.map((choice) => choice.id).join('\n')
      if (this.scoreSelect.dataset['ids'] !== ids) {
        this.scoreSelect.replaceChildren(
          ...held.scores.choices.map((choice) => el('option', { value: choice.id, text: choice.label })),
        )
        this.scoreSelect.dataset['ids'] = ids
      }
      this.scoreSelect.value = held.scores.current
      this.smoothSelect.value = held.derive.smooth
      const baseline = held.derive.baseline === true
      const oe = !baseline && (held.derive.expected === true || held.derive.correlate === true)
      this.oeButton.setAttribute('aria-pressed', String(oe))
      this.oeButton.toggleAttribute('disabled', baseline)
      const hint = baseline ? OE_ON_BASELINE_HINT : OE_HINT
      this.oeButton.title = hint
      this.oeButton.setAttribute('aria-label', hint)
    }
    this.transformSelect.value = this.transform
    this.colormapSelect.value = this.colormap
    this.paintClipUnits()
  }

  private paintClipUnits(): void {
    this.clipLabel.textContent = this.transform === 'none' ? 'clip' : `clip (${this.transform})`
  }

  /** The bounds drawn, for the clip boxes' caption once a block has been coloured. */
  showBounds(effective: ColorScale): void {
    if (!Number.isFinite(effective.vmin) || !Number.isFinite(effective.vmax)) return
    this.clip.setValues(
      { vmin: effective.vmin, vmax: effective.vmax },
      this.manualVmin === undefined && this.manualVmax === undefined,
    )
  }

  /** What the cells below the diagonal hold, in the picker's word. */
  scoreWord(): string {
    const scores = this.presentation?.scores
    const choice = scores?.choices.find((entry) => entry.id === scores.current)
    return choice?.label ?? (this.presentation?.balance === true ? 'balanced' : 'count')
  }

  /**
   * What the derived field below the diagonal is called, or `null` where its
   * cells are as read — the panel's `derivedLabel`, for this triangle.
   */
  derivedLabel(): string | null {
    const derive = this.presentation?.derive
    if (derive === undefined) return null
    if (derive.baseline === true) return this.scoreWord()
    const arms = derive.arms?.refusal === null && armsKey(derive.arms) !== ''
    return derive.expected === true || derive.correlate === true ? (arms ? 'arm O/E' : 'O/E') : null
  }

  /** The words after the score in the key: the derivation, where it is not the score's own name. */
  private units(): string {
    const label = this.derived?.label ?? 'counts'
    return label === 'counts' || label === this.scoreWord() ? '' : label
  }

  /** The second key's contents, marked with where on the picture this reading is. */
  keyFor(scale: ColorScale, mark: string, note: { note?: string }): KeyContent {
    const title = keyTitle([this.scoreWord(), this.units()], scale.transform, mark)
    return { ...keyContent(scale, title, (value) => trimNumber(value, 3)), ...note }
  }

  /** The derived value at a cell of the lower reading's square, as the readout says it. */
  reading(slot: number): string | null {
    const label = this.derivedLabel()
    const values = this.derived?.values
    if (label === null || values === undefined) return null
    const drawn = values[slot]
    if (drawn === undefined || Number.isNaN(drawn)) return `${label} —`
    return this.neutral === 1 ? `${label} ${trimNumber(drawn, 3)}×` : `${label} ${trimNumber(drawn, 3)}`
  }

  /** What the caption says of this reading, in the order its arithmetic ran. */
  captionParts(): string[] {
    const parts = [`below the diagonal: ${this.scoreWord()}`]
    const label = this.derived?.label
    if (label !== undefined && label !== 'counts' && label !== this.scoreWord()) parts.push(label)
    if (this.derived?.scope != null) parts.push(this.derived.scope)
    parts.push(this.transform === 'none' ? 'linear' : this.transform)
    return parts
  }

  destroy(): void {
    this.derivation.destroy()
  }
}
