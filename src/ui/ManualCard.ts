/**
 * The **Manual annotations** card (spec §8.1): the marks a reader draws
 * themselves.
 *
 * Two ways in for each kind, because the two are wanted at different moments.
 * Typing coordinates is what you do when you already know them — from a paper,
 * from a table, from the readout you just copied. Clicking the map is what you
 * do when you are looking at the thing and want to point at it. Neither is a
 * fallback for the other, so both are first-class and both produce exactly the
 * same mark.
 */

import {
  MANUAL_PALETTE,
  formatPoint,
  mintMarkId,
  parsePoint,
  type LineAxis,
  type ManualMark,
  type ManualPoint,
  type ManualStore,
} from '../annotations/manual'
import { button, el } from './dom'
import { iconButton } from './icons'

/**
 * How the card reaches the mounted plot.
 *
 * An interface rather than a reference, because the card lives in the shell's
 * sidebar and the plot is inside whichever view is mounted — which changes under
 * it. The shell implements this by forwarding to whatever is on screen, and a
 * card that is up while nothing is answers by disabling its own buttons.
 */
export interface MapPicker {
  /** `true` when there is a plot to click on. */
  available(): boolean
  /**
   * Collect `count` clicks. Resolves with one point *per axis* per click, or
   * `null` if the reader pressed Escape or navigated away.
   */
  pick(count: number): Promise<Array<{ rows: ManualPoint; cols: ManualPoint }> | null>
}

export interface ManualCardProps {
  store: ManualStore
  picker: MapPicker
}

export class ManualCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly unsubscribe: () => void
  private readonly buttons: HTMLButtonElement[] = []

  constructor(private readonly props: ManualCardProps) {
    this.el = el(
      'section',
      { class: 'card annotation-card' },
      el('h3', { text: 'Manual annotations' }),
      el('p', {
        class: 'hint',
        text:
          'Marks you place yourself, in genomic coordinates — so they survive a zoom, a pan and ' +
          'a change of resolution.',
      }),
      this.lineForm(),
      this.arrowForm(),
      this.list,
    )
    this.unsubscribe = props.store.subscribe(() => this.render())
    this.render()
  }

  destroy(): void {
    this.unsubscribe()
  }

  /** Enable or disable the pick buttons as views come and go. */
  refresh(): void {
    const ready = this.props.picker.available()
    for (const node of this.buttons) node.disabled = !ready
  }

  // -------------------------------------------------------------------------
  // Adding
  // -------------------------------------------------------------------------

  private lineForm(): HTMLElement {
    const axis = el('select', { class: 'select' })
    for (const [value, label] of [
      ['vertical', 'vertical'],
      ['horizontal', 'horizontal'],
      ['both', 'both'],
    ] as const) {
      axis.appendChild(el('option', { value, text: label }))
    }

    const at = el('input', { class: 'input', type: 'text', placeholder: 'I:120000' })
    const add = (point: ManualPoint): void => {
      this.props.store.add({
        id: mintMarkId(),
        kind: 'line',
        axis: axis.value as LineAxis,
        at: point,
        colour: this.props.store.nextColour(),
        label: '',
      })
    }
    const typed = button('add', () => {
      const point = parsePoint(at.value)
      if (point === null) {
        at.classList.add('is-bad')
        return
      }
      at.classList.remove('is-bad')
      add(point)
      at.value = ''
    })
    at.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') typed.click()
    })

    // A vertical rule is a column, so it takes the column axis of the click; a
    // horizontal one takes the row. "Both" is one coordinate drawn twice, and
    // on the diagonal — where these are nearly always placed — the two axes
    // give the same answer anyway.
    const pick = this.pickButton('pick on map', 1, (points) => {
      const choice = axis.value === 'horizontal' ? points[0].rows : points[0].cols
      add(choice)
    })

    return el(
      'div',
      { class: 'manual-form' },
      el('span', { class: 'manual-form-title', text: 'Lines' }),
      el('div', { class: 'manual-row' }, axis, at),
      el('div', { class: 'manual-row' }, typed, pick),
    )
  }

  private arrowForm(): HTMLElement {
    const first = el('input', { class: 'input', type: 'text', placeholder: 'I:120000 (rows)' })
    const second = el('input', { class: 'input', type: 'text', placeholder: 'I:340000 (columns)' })
    const add = (a: ManualPoint, b: ManualPoint): void => {
      this.props.store.add({
        id: mintMarkId(),
        kind: 'arrowhead',
        a,
        b,
        colour: this.props.store.nextColour(),
        label: '',
      })
    }
    const typed = button('add', () => {
      const a = parsePoint(first.value)
      // One coordinate is a mark on the diagonal, which is the on-diagonal case
      // and is worth not making anyone type twice.
      const b = second.value.trim() === '' ? a : parsePoint(second.value)
      first.classList.toggle('is-bad', a === null)
      second.classList.toggle('is-bad', b === null)
      if (a === null || b === null) return
      add(a, b)
      first.value = ''
      second.value = ''
    })

    // One click is a cell, and a cell already has both coordinates — so an
    // arrowhead needs exactly one click, not two.
    const pick = this.pickButton('pick on map', 1, (points) => {
      add(points[0].rows, points[0].cols)
    })

    return el(
      'div',
      { class: 'manual-form' },
      el('span', { class: 'manual-form-title', text: 'Arrowheads' }),
      el('div', { class: 'manual-row' }, first, second),
      el('div', { class: 'manual-row' }, typed, pick),
    )
  }

  private pickButton(
    label: string,
    count: number,
    done: (points: Array<{ rows: ManualPoint; cols: ManualPoint }>) => void,
  ): HTMLButtonElement {
    const node = button(
      label,
      () => {
        node.classList.add('is-armed')
        void this.props.picker.pick(count).then((points) => {
          node.classList.remove('is-armed')
          if (points !== null && points.length === count) done(points)
        })
      },
      {
        class: 'btn',
        title: 'Then click the plot. Escape gives up without placing anything.',
      },
    )
    node.disabled = !this.props.picker.available()
    this.buttons.push(node)
    return node
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  private render(): void {
    const marks = this.props.store.marks
    if (marks.length === 0) {
      this.list.replaceChildren()
      return
    }
    this.list.replaceChildren(
      ...marks.map((mark) => this.row(mark)),
      button('remove all', () => this.props.store.clear(), {
        class: 'btn btn-quiet btn-wide',
        title: 'Clear every hand-drawn mark on this file',
      }),
    )
  }

  private row(mark: ManualMark): HTMLElement {
    const colour = el('input', { class: 'ann-colour', type: 'color', value: mark.colour })
    colour.addEventListener('input', () => this.props.store.update(mark.id, { colour: colour.value }))

    const label = el('input', {
      class: 'input manual-label',
      type: 'text',
      value: mark.label,
      placeholder: describe(mark),
    })
    label.title = 'A caption drawn beside the mark. Empty draws none.'
    label.addEventListener('change', () => this.props.store.update(mark.id, { label: label.value }))

    return el(
      'div',
      { class: 'ann-row manual-mark' },
      el(
        'div',
        { class: 'ann-head' },
        colour,
        el('span', { class: 'manual-where', text: describe(mark), title: describe(mark) }),
        iconButton('x', 'Remove this mark', () => this.props.store.remove(mark.id), {
          class: 'btn-close',
          size: 14,
        }),
      ),
      label,
    )
  }
}

/** A mark, written the way its own inputs would take it back. */
function describe(mark: ManualMark): string {
  if (mark.kind === 'line') {
    const glyph = mark.axis === 'vertical' ? '│' : mark.axis === 'horizontal' ? '─' : '┼'
    return `${glyph} ${formatPoint(mark.at)}`
  }
  const a = formatPoint(mark.a)
  const b = formatPoint(mark.b)
  return a === b ? `◤ ${a}` : `◤ ${a} × ${b}`
}

/** Re-exported so a caller needs one import to seed a colour. */
export { MANUAL_PALETTE }
