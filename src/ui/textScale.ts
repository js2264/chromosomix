/**
 * How big the writing on the pictures is, shared by every canvas on screen.
 *
 * A sibling of `ui/plotOptions.ts`, in the same place and for the same reasons.
 * The panels are rebuilt on every navigation, so an instance field would lose
 * the choice on the first click; and the two surfaces have to agree, because a
 * track name that is one size beside a map and another in the browser is the
 * application disagreeing with itself about the same track.
 *
 * A *multiplier* rather than a size, and that is the whole design. Sixteen
 * different sizes are written down across this app and each was chosen against
 * the thing it sits on — nine pixels fits a sixteen-pixel lane, thirteen and
 * semibold is what a chromosome name in a ruler band wants — so a single
 * absolute size would flatten a hierarchy somebody thought about. Scaling keeps
 * every one of those relationships and moves all of them together.
 *
 * `localStorage`, not the URL hash: §5.5 shares *what is being looked at*, and
 * how large a reader needs the small print is not that.
 */

import { el } from './dom'
import { iconButton } from './icons'

const KEY = 'chromosomix:text-scale'

/**
 * The rungs, coarse enough that one press is a visible change.
 *
 * Not a slider and not a number box: a reader adjusting this is looking at the
 * picture rather than at the control, and what they want is *bigger* — which is
 * a press, repeated until it is right. Six steps over a range of two, so the
 * two ends are genuinely different pictures rather than two ways of saying the
 * same one.
 */
export const TEXT_SCALE_STEPS = [0.8, 0.9, 1, 1.15, 1.35, 1.6] as const

/**
 * The rung a reader who has never touched the control lands on.
 *
 * Two rungs above the identity, and deliberately not the identity. The sizes in
 * this app were picked against the *geometry* — the nine pixels that fits a
 * sixteen-pixel lane — and geometry does not care how far away the screen is.
 * Read at a desk on a large display, which is where a contact map is read, the
 * unscaled marks are legible in the sense that they can be made out rather than
 * in the sense that they can be read, and the first thing anybody did on opening
 * a map was reach for this control. So the control's job is to take a reader
 * back down to the drawn sizes, not to get them up to a usable one.
 *
 * The identity is still a rung, and everything measured in this suite is still
 * measured there: 1.0 is the number the golden renders are written against.
 */
export const DEFAULT_TEXT_SCALE = 1.35

let current: number | null = null
const listeners = new Set<(scale: number) => void>()

/** The rung nearest a number — how a stored value and a step both land. */
function snap(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TEXT_SCALE
  let best: number = TEXT_SCALE_STEPS[0]
  for (const step of TEXT_SCALE_STEPS) {
    if (Math.abs(step - value) < Math.abs(best - value)) best = step
  }
  return best
}

/** Stored state outlives the code that wrote it, so the value is checked. */
function read(): number {
  try {
    const raw = window.localStorage.getItem(KEY)
    return raw === null ? DEFAULT_TEXT_SCALE : snap(Number(raw))
  } catch {
    return DEFAULT_TEXT_SCALE
  }
}

/**
 * Publish the scale as a CSS variable, for the boxes that hold canvas text.
 *
 * Almost nothing needs this: DOM text is sized by the type scale and moves with
 * the page, and a canvas that fills its container simply redraws larger. The
 * exception is a canvas whose *box* is fixed in CSS and whose contents are
 * mostly words — the colourbar, which is a strip of colour and a column of
 * numbers in a box five and a half rems wide. Grown text there does not reflow,
 * it is clipped, and a legend reading `≤ 0.00006` as `≤ 0.0000` is a legend that
 * lies. So the one number both sides need lives in one place and CSS multiplies
 * by it.
 *
 * Guarded on `document` rather than on `window`: this module is loaded under
 * Node with a stubbed `window` and no DOM at all.
 */
function publish(scale: number): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--text-scale', String(scale))
}

/** The scale in force. */
export function getTextScale(): number {
  if (current === null) {
    current = read()
    publish(current)
  }
  return current
}

/** Set the scale, snapping to a rung, and tell every mounted surface. */
export function setTextScale(scale: number): void {
  const next = snap(scale)
  if (next === current) return
  current = next
  cache.clear()
  publish(next)
  try {
    window.localStorage.setItem(KEY, String(next))
  } catch {
    /* a browser that refuses storage still honours the press for this session */
  }
  for (const listener of listeners) listener(next)
}

/** One rung up or down, clamped at the ends. Returns the scale now in force. */
export function stepTextScale(delta: -1 | 1): number {
  const steps: readonly number[] = TEXT_SCALE_STEPS
  const at = steps.indexOf(getTextScale())
  const next = Math.max(0, Math.min(TEXT_SCALE_STEPS.length - 1, (at < 0 ? 2 : at) + delta))
  setTextScale(TEXT_SCALE_STEPS[next])
  return getTextScale()
}

/** Subscribe to changes; returns the unsubscribe function. */
export function subscribeTextScale(listener: (scale: number) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Memoised, because this is called per lane per frame.
 *
 * Cleared by {@link setTextScale} rather than keyed by the scale, so a stale
 * entry cannot outlive the change that made it stale — a cache that is not
 * invalidated is a control that appears to do nothing.
 */
const cache = new Map<string, string>()

/** Matches the size in a CSS font shorthand, decimals and all. */
const SIZE = /(\d+(?:\.\d+)?)px/

/**
 * A CSS font shorthand at the scale in force.
 *
 * The size is the only part that moves: the weight and the family are what the
 * mark *is*, and a 600-weight name that thinned out as it grew would be a
 * different label rather than a larger one. A string with no `px` run in it
 * comes back untouched.
 *
 * **Identity at 1.0**, and that is a requirement rather than an optimisation:
 * the golden renders and every measured-label test compare against sizes
 * written down as literals, and a scale that rewrote `10px` as `10px` through a
 * regex would still be one rounding away from moving all of them.
 */
export function scaleFont(font: string): string {
  const scale = getTextScale()
  if (scale === 1) return font
  const held = cache.get(font)
  if (held !== undefined) return held
  const scaled = font.replace(SIZE, (_, size: string) => `${round(Number(size) * scale)}px`)
  cache.set(font, scaled)
  return scaled
}

/**
 * A length measured in the same units as the text it is spacing.
 *
 * Line heights, the band a feature's name sits in, the pill a coordinate is
 * written in: every one of these was chosen against a font size, and leaving
 * them fixed while the text grows is what makes a scaled label overlap the one
 * under it. Integers, because these are pixel offsets rather than type.
 */
export function scaleLength(px: number): number {
  const scale = getTextScale()
  return scale === 1 ? px : Math.round(px * scale)
}

/** To a tenth of a pixel: 9 px at 1.15 must not collapse back to 9. */
function round(px: number): number {
  return Math.round(px * 10) / 10
}

/**
 * The control both Tracks cards carry: smaller, what it is now, larger.
 *
 * A pair of presses and a percentage rather than a slider or a number box, for
 * the reason the steps are coarse: a reader adjusting this is looking at the
 * picture, not at the control, and what they want is *bigger* — repeated until
 * it is right. The ends grey out, so the range is visible without being tried.
 *
 * Built by a factory and mounted twice, exactly as `trackHeightField` and
 * `everyTrackOpacityField` are: one preference about one thing, offered in the
 * two places a reader is standing when they want it.
 */
export function textScaleField(): HTMLElement {
  const readout = el('span', { class: 'clip-note text-scale-note' })
  const smaller = iconButton(
    'chevron-down',
    'Smaller text on the pictures — track names, value ranges, coordinates, gene names',
    () => stepTextScale(-1),
    { class: 'btn btn-icon', size: 15 },
  )
  const larger = iconButton(
    'chevron-up',
    'Larger text on the pictures — track names, value ranges, coordinates, gene names',
    () => stepTextScale(1),
    { class: 'btn btn-icon', size: 15 },
  )
  const sync = (): void => {
    const scale = getTextScale()
    readout.textContent = String(Math.round(scale * 100))
    smaller.disabled = scale <= TEXT_SCALE_STEPS[0]
    larger.disabled = scale >= TEXT_SCALE_STEPS[TEXT_SCALE_STEPS.length - 1]
  }
  sync()
  const row = el(
    'div',
    { class: 'field field-block' },
    el('span', { class: 'field-label', text: 'text size' }),
    // The unit after the control, not inside the readout — which is where
    // `opacity` beside it puts its own, and the two are deliberately one
    // question asked twice (`ui/trackControls.ts` → `fieldPair`). `135%` between
    // the chevrons and a bare `100` with a `%` after them made the pair read as
    // two kinds of control.
    el(
      'div',
      { class: 'plot-icon-row' },
      smaller,
      readout,
      larger,
      el('span', { class: 'clip-note field-unit', text: '%' }),
    ),
  )
  // The store outlives this control — a card is rebuilt on every navigation and
  // nothing hands the outgoing one a teardown — so the listener retires itself
  // the first time it is spoken to after leaving the document.
  const off = subscribeTextScale(() => {
    if (!row.isConnected) {
      off()
      return
    }
    sync()
  })
  return row
}
