/**
 * The two controls that sit *on* a lane, wherever a lane is drawn.
 *
 * Both are hit targets for marks the canvas has already painted: a transparent
 * colour input over the chip before a track's name, and the autoscale button
 * immediately after the range. Neither decides a layout — each is positioned per
 * frame from the box the paint measured ({@link drawLaneLabel}), so the control
 * and the thing it acts on cannot come to disagree about where they are.
 *
 * Written once and mounted twice. The 1D browser had all of this and the lanes
 * beside the map had none of it, which meant that beside a map the range under a
 * track's name was inert text and its colour was two clicks into a context menu.
 * The layer is what makes a canvas pointable at all, so it belongs to neither
 * view.
 *
 * The host must be `pointer-events: none` and positioned: everywhere on a lane
 * that is not one of these small rectangles, a press is still a pan.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry } from '../annotations/types'
import type { LabelBox } from '../render/laneLabel'
import { isMac } from './commands'
import { el } from './dom'
import { iconButton } from './icons'

/** The autoscale mark beside a lane's range: the glyph, and nothing else. */
export const AUTO_ICON = 13

/** One control to place this frame, and what the canvas drew it against. */
export type LaneMark =
  | { kind: 'swatch'; entries: AnnotationEntry[]; box: LabelBox }
  | { kind: 'auto'; entries: AnnotationEntry[]; at: { x: number; y: number } }

/**
 * A colour picker for one track.
 *
 * An `<input type=color>` rather than a button that opens one, because the
 * input *is* the swatch — what it opens is the app's picker (`colourPicker.ts`,
 * §26.6), which takes over every colour input in the document. Shared
 * with the lane's right-click menu, so the two cannot drift about what a colour
 * is.
 */
export function colourInput(
  entry: AnnotationEntry,
  store: AnnotationStore,
  options: { class?: string } = {},
): HTMLInputElement {
  const input = el('input', {
    class: options.class ?? 'lane-swatch',
    type: 'color',
    value: entry.style.colour,
    title: `Colour for ${entry.label}`,
  })
  input.addEventListener('input', () => store.restyle(entry.id, { colour: input.value }))
  return input
}

export class LaneControls {
  /**
   * What the last rebuild was for.
   *
   * The nodes are re-*positioned* every frame and re-*built* only when the set
   * of marks changes, because moving an element is not replacing it — and
   * replacing one under the pointer mid-drag cancels the drag, which this runs on
   * every frame of.
   */
  private signature = ''

  constructor(
    private readonly host: HTMLElement,
    private readonly store: AnnotationStore,
    /**
     * Told when the set of marks changed, so a caret measured into a lane that
     * has moved can be taken away. A track added, removed or regrouped moves the
     * lane an open editor was anchored to, and a box hanging over the wrong lane
     * would commit its number to the right one. A pan changes no signature, which
     * is why the caret survives one.
     */
    private readonly onRebuild: () => void = () => {},
  ) {}

  /**
   * Put this frame's controls where the paint says they go.
   *
   * `offset` converts the lane canvas's own pixels into the host's. Beside a map
   * the two are different boxes — the stacks are grid items and the layer is
   * positioned against the grid — while in the browser the canvas and the layer
   * share an origin and it is zero.
   */
  sync(marks: readonly LaneMark[], offset: { left: number; top: number }): void {
    const signature = marks
      .map((mark) => `${mark.kind}:${mark.entries.map((entry) => entry.id).join('+')}`)
      .join('|')
    if (signature !== this.signature) {
      const first = this.signature === ''
      this.signature = signature
      this.host.replaceChildren(...marks.map((mark) => this.build(mark)))
      if (!first) this.onRebuild()
    }

    const nodes = this.host.children
    for (let i = 0; i < marks.length; i++) {
      const mark = marks[i]
      const node = nodes[i]
      if (!(node instanceof HTMLElement)) continue
      if (mark.kind === 'swatch') {
        const [x, y, width, height] = mark.box
        node.style.left = `${offset.left + x}px`
        node.style.top = `${offset.top + y}px`
        node.style.width = `${width}px`
        node.style.height = `${height}px`
        // Not while it is the focused control: writing the value under an open
        // picker is what closes it.
        if (node instanceof HTMLInputElement && node !== document.activeElement) {
          node.value = mark.entries[0]?.style.colour ?? node.value
        }
        continue
      }
      // Centred on the mark rather than hung from its corner: the button is a
      // glyph beside two numbers and has to sit on the same line as them.
      node.style.left = `${offset.left + mark.at.x - AUTO_ICON / 2}px`
      node.style.top = `${offset.top + mark.at.y - AUTO_ICON / 2}px`
      // Lit while the axis on screen is the data's own, which the button would
      // otherwise give no way of knowing without pressing it.
      const auto = mark.entries.every(
        (entry) => this.store.byId(entry.id)?.style.limits.auto === true,
      )
      node.classList.toggle('is-on', auto)
      node.setAttribute('aria-pressed', String(auto))
    }
  }

  /** Take every control away — a stack that has lost its last lane. */
  clear(): void {
    if (this.signature === '') return
    this.signature = ''
    this.host.replaceChildren()
    this.onRebuild()
  }

  destroy(): void {
    this.host.replaceChildren()
    this.signature = ''
  }

  private build(mark: LaneMark): HTMLElement {
    const entries = mark.entries
    if (mark.kind === 'swatch') {
      const entry = entries[0]
      return entry === undefined ? el('span') : colourInput(entry, this.store)
    }
    // Hand this lane's value axis back to the data. Every track in the lane, not
    // the one whose numbers happened to be written down: a lane draws one range
    // under however many names it holds, so handing back half of it would leave
    // two lines at two scales under one label.
    const named = entries.map((entry) => entry.label).join(', ')
    return iconButton(
      'chevrons-up-down',
      // One clause, like the same glyph's title in the Tracks card. It carried
      // two sentences, the second a modifier tutorial — and that gesture is
      // already said twice, in the lane menu that exists to carry it and in the
      // shortcuts dialog; a 13-pixel glyph is not the third place. A hint says
      // what a control wants of the reader.
      `Autoscale ${named} to what is in view`,
      () => {
        for (const entry of entries) {
          const current = this.store.byId(entry.id)?.style.limits ?? entry.style.limits
          this.store.restyle(entry.id, { limits: { ...current, auto: true } })
        }
      },
      { class: 'btn btn-icon lane-auto', size: AUTO_ICON },
    )
  }
}

/**
 * How far a press must travel before it is a drag with a direction.
 *
 * One number for both surfaces, because it decides the same question on each: a
 * press in a lane's body is a pan along the axis or a pull on that lane's
 * ceiling, and which one it is has to be read from the first few pixels. Small
 * enough that neither gesture feels held back, large enough that a hand aiming
 * along the axis is not read as aiming across it.
 */
export const DRAG_SLACK = 3

/**
 * The modifier that turns a scroll over a lane into a ceiling adjustment.
 *
 * ⌘ on a Mac and Alt elsewhere, and **never** Ctrl. A trackpad pinch is
 * delivered as a `wheel` event with `ctrlKey` set, on every platform, so taking
 * Ctrl here would swallow every pinch and silently run away with a track's
 * ceiling instead of zooming — and on Windows and Linux it would shadow the
 * browser's own zoom as well. Left alone, a pinch falls through to the zoom,
 * which is what a pinch should do.
 */
export const CEILING_MODIFIER = (event: WheelEvent): boolean =>
  isMac() ? event.metaKey && !event.ctrlKey : event.altKey

/** What to call it in a tooltip, on this platform. */
export const CEILING_LABEL = isMac() ? '⌘-scroll' : 'Alt-scroll'

/**
 * How far one notch moves a ceiling.
 *
 * A quarter, multiplicatively, so the gesture composes: four notches up and four
 * down is where you started, which an additive step over a range that spans four
 * orders of magnitude could not be.
 */
export const CEILING_STEP = 1.25
