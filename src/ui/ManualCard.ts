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
 *
 * Three kinds, and they are three sentences: a line says *this coordinate*, an
 * arrowhead says *this cell*, a rectangle says *this block of contacts*.
 */

import {
  MANUAL_PALETTE,
  formatPoint,
  formatSpan,
  mintMarkId,
  parsePoint,
  parseSpan,
  type LineAxis,
  type ManualMark,
  type ManualPoint,
  type ManualSpan,
  type ManualStore,
} from '../annotations/manual'
import { formatMarks, marksFor, type MarkFormat } from '../annotations/export'
import { button, el } from './dom'
import { downloadBlob, exportBaseName, fileStamp } from './export'
import { cardTitle, iconButton } from './icons'
import type { PickHandlers } from './mapPick'

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
   * Turn on picking, for as long as the mode lasts.
   *
   * Which gesture the mode listens for is decided by what the form hands over:
   * `point` takes every click as one locus per axis, `box` takes every drag as
   * one stretch per axis ({@link PickHandlers}).
   *
   * `onEnd` fires exactly once, however the mode ends — the returned stop
   * function, Escape, another gesture arming over this one, or the plot going
   * away underneath it. That is what the button re-labels itself from, so it
   * must not be conditional on how the mode finished.
   *
   * @returns a function that ends the mode.
   */
  start(handlers: PickHandlers, onEnd: () => void): () => void
}

export interface ManualCardProps {
  store: ManualStore
  picker: MapPicker
  /** The open file's short name, for what a saved file is called. */
  fileLabel: string
}

export class ManualCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly unsubscribe: () => void
  private readonly buttons: HTMLButtonElement[] = []
  private readonly formatSelect = el('select', { class: 'select' })
  private readonly saveButton: HTMLButtonElement

  constructor(private readonly props: ManualCardProps) {
    this.saveButton = button('Save', () => this.save(), {
      class: 'btn',
      title: 'Write these marks to a file this app — and bedtools — reads back',
    })
    this.el = el(
      'section',
      { class: 'card annotation-card' },
      cardTitle('Manual annotations', 'pencil'),
      this.lineForm(),
      this.arrowForm(),
      this.rectForm(),
      this.list,
      this.exportRow(),
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
    //
    // Read from the select on every click rather than captured once: the mode
    // now outlives a single mark, so a reader may well place two verticals,
    // switch to horizontal and place a third without leaving it.
    const pick = this.pickButton('pick on map', {
      point: (at) => add(axis.value === 'horizontal' ? at.rows : at.cols),
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
    // arrowhead is one click, not two.
    const pick = this.pickButton('pick on map', { point: (at) => add(at.rows, at.cols) })

    return el(
      'div',
      { class: 'manual-form' },
      el('span', { class: 'manual-form-title', text: 'Arrowheads' }),
      el('div', { class: 'manual-row' }, first, second),
      el('div', { class: 'manual-row' }, typed, pick),
    )
  }

  /**
   * Boxes: a stretch of rows by a stretch of columns.
   *
   * Two ranges rather than a range and a shape, so that on- and off-diagonal are
   * the same form and any ratio is expressible — a domain is `I:120000-180000`
   * against itself, a corner peak is two short stretches a megabase apart, and a
   * locus against a whole arm is a short one against a long one. Leaving the
   * second box empty means *the same stretch on both axes*, which is the box on
   * the diagonal and is not worth making anybody type twice; it is the same
   * courtesy the arrowhead form does for a cell on the diagonal.
   *
   * **Drawn with a drag**, which is the gesture a hand already makes for a box:
   * press at one corner, let go at the other, and the marquee the map draws
   * while the button is down is the mark that is about to exist. It used to be
   * two clicks, and two clicks made the reader hold a corner in their head
   * between them — the card had to say which one it was holding, because the
   * picture could not.
   *
   * Holding **Shift** while drawing locks the box to the diagonal, so a domain
   * is one gesture. On a turned map every drag is that, the band being the only
   * thing there with coordinates on it.
   */
  private rectForm(): HTMLElement {
    const first = el('input', { class: 'input', type: 'text', placeholder: 'I:120000-180000 (rows)' })
    const second = el('input', { class: 'input', type: 'text', placeholder: 'I:340000-400000 (columns)' })
    const add = (a: ManualSpan, b: ManualSpan): void => {
      this.props.store.add({
        id: mintMarkId(),
        kind: 'rect',
        a,
        b,
        colour: this.props.store.nextColour(),
      })
    }
    const typed = button('add', () => {
      const a = parseSpan(first.value)
      const b = second.value.trim() === '' ? a : parseSpan(second.value)
      first.classList.toggle('is-bad', a === null)
      second.classList.toggle('is-bad', b === null)
      if (a === null || b === null) return
      add(a, b)
      first.value = ''
      second.value = ''
    })
    for (const box of [first, second]) {
      box.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') typed.click()
      })
    }

    const pick = this.pickButton('draw on map', {
      box: (at) => add(at.rows, at.cols),
    })

    return el(
      'div',
      { class: 'manual-form' },
      el('span', { class: 'manual-form-title', text: 'Rectangles' }),
      el('div', { class: 'manual-row' }, first, second),
      el('div', { class: 'manual-row' }, typed, pick),
    )
  }

  /**
   * A button that turns picking on, and then turns it off.
   *
   * One button with two labels rather than two controls: while the mode is on,
   * the only thing the reader can want from this button is to stop, so that is
   * what it offers. `Done` and Escape are the same act by two roads, which is
   * why both run {@link end}.
   *
   * The mode is *not* ended by placing a mark. Marking up a figure means placing
   * several — four domains boxed, every loop worth an arrowhead — and the round
   * trip to the sidebar between each one was the whole cost of doing it here
   * rather than by typing coordinates.
   *
   * What the mode listens for is whatever the form handed over: a click for the
   * two marks that name a place, a drag for the one that names an extent. The
   * button says which in its own hint, since a reader who clicks at a map that
   * is waiting for a drag has been given no way to find that out.
   */
  private pickButton(label: string, handlers: PickHandlers): HTMLButtonElement {
    const hint =
      handlers.box === undefined
        ? 'Then click the plot, as often as you like. Escape or Done stops.'
        : 'Then drag a box on the plot, as many as you like — Shift keeps it on the diagonal. ' +
          'Escape or Done stops.'
    let stop: (() => void) | null = null

    const rest = (): void => {
      stop = null
      node.classList.remove('is-armed')
      node.textContent = label
      node.title = hint
      // Every pick button on the card comes back at once: only one mode can be
      // on, so arming the other one has just ended this.
      this.refresh()
    }

    const node = button(
      label,
      () => {
        if (stop !== null) {
          stop()
          return
        }
        node.classList.add('is-armed')
        node.textContent = 'Done'
        node.title = 'Stop placing marks. Escape does the same.'
        // Set before `start`, so a picker that ends the mode synchronously —
        // because there is no plot — still finds something to clear.
        stop = () => {}
        const end = this.props.picker.start(handlers, rest)
        if (stop !== null) stop = end
      },
      { class: 'btn', title: hint },
    )
    node.disabled = !this.props.picker.available()
    this.buttons.push(node)
    return node
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  /**
   * Saving the marks: a format, and a button — the export row from the
   * Aesthetics panel, in the card whose contents it writes.
   *
   * The dropdown chooses *which marks*, not just which container, because the
   * kinds are different objects and there is one standard file for each: a line
   * is a point on the genome, and a loop and a box are each a pair of places.
   * Saying so in the option label is more honest than a single "export" that
   * quietly writes half of what is on screen.
   */
  private exportRow(): HTMLElement {
    for (const [value, text] of [
      ['bed', 'lines (BED)'],
      ['bedpe', 'loops & boxes (BEDPE)'],
    ] as Array<[MarkFormat, string]>) {
      this.formatSelect.appendChild(el('option', { value, text }))
    }
    this.formatSelect.addEventListener('change', () => this.paintSave())
    return el(
      'div',
      { class: 'field field-block manual-export' },
      el('span', { class: 'field-label', text: 'export' }),
      el('div', { class: 'export-row' }, this.formatSelect, this.saveButton),
    )
  }

  /** Nothing of this kind to write is a disabled button, not an empty file. */
  private paintSave(): void {
    const format = this.formatSelect.value as MarkFormat
    const count = marksFor(this.props.store.marks, format).length
    this.saveButton.disabled = count === 0
    this.saveButton.title =
      count === 0
        ? `No ${format === 'bed' ? 'lines' : 'loops or boxes'} have been drawn yet`
        : `Write ${count} to a file this app — and bedtools — reads back`
  }

  private save(): void {
    const format = this.formatSelect.value as MarkFormat
    const now = new Date()
    const text = formatMarks(this.props.store.marks, format, {
      file: this.props.fileLabel,
      created: fileStamp(now),
    })
    downloadBlob(
      new Blob([text], { type: 'text/plain' }),
      `${exportBaseName(this.props.fileLabel)}-marks-${fileStamp(now)}.${format}`,
    )
  }

  private render(): void {
    this.paintSave()
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

    // A colour, where it is, and a way to remove it. A mark says *look here*;
    // what to look at is the map, and a caption box under every one of them was
    // a text field to fill in for a sentence the figure already makes.
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
    )
  }
}

/** A mark, written the way its own inputs would take it back. */
function describe(mark: ManualMark): string {
  if (mark.kind === 'line') {
    const glyph = mark.axis === 'vertical' ? '│' : mark.axis === 'horizontal' ? '─' : '┼'
    return `${glyph} ${formatPoint(mark.at)}`
  }
  if (mark.kind === 'rect') {
    const a = formatSpan(mark.a)
    const b = formatSpan(mark.b)
    // One extent for a box on the diagonal, which is what its form takes back.
    return a === b ? `▭ ${a}` : `▭ ${a} × ${b}`
  }
  const a = formatPoint(mark.a)
  const b = formatPoint(mark.b)
  return a === b ? `◤ ${a}` : `◤ ${a} × ${b}`
}

/** Re-exported so a caller needs one import to seed a colour. */
export { MANUAL_PALETTE }
