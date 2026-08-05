/**
 * The one box a view is typed into, wearing the key that reaches it.
 *
 * Every view in this app answers a name: a heatmap opens the contig or the
 * genome you type, a table filters to it, the browser goes there. Those boxes
 * were built one per view, which was fine while each was the only one on
 * screen — and wrong the moment `/` became a key the whole app answers, because
 * a key needs one place to put the caret and four views had four spellings of
 * it, two of which had no box at all.
 *
 * So the box is one object with one shape, and it prints its own shortcut. The
 * badge is the discoverable half: a tooltip is found by someone who already
 * suspects there is something to find, while a `/` sitting in the box is read
 * by everyone who looks at the box. It steps out of the way on focus, because
 * from that moment the reader is typing rather than looking for the way in.
 */

import { el } from './dom'
import { KEYS, keyLabel } from './commands'

export interface SearchBoxOptions {
  placeholder: string
  /** The box's own tooltip: what typing here will do. */
  title?: string
  /** What it holds before anyone types — the current region, usually. */
  value?: string
  /** Extra classes for the input, for the views that size their own. */
  inputClass?: string
  /** Enter was pressed, or the `go` button beside it was clicked. */
  onSubmit(text: string): void
  /** Every keystroke, for a box that answers as you type. */
  onInput?(text: string): void
}

export class SearchBox {
  /** The wrapper: the badge is positioned against it, so it goes in the DOM. */
  readonly el: HTMLElement
  readonly input: HTMLInputElement

  constructor(options: SearchBoxOptions) {
    this.input = el('input', {
      class: `input search-input${options.inputClass === undefined ? '' : ` ${options.inputClass}`}`,
      type: 'text',
      placeholder: options.placeholder,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.value === undefined ? {} : { value: options.value }),
    })
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') options.onSubmit(this.input.value.trim())
    })
    if (options.onInput !== undefined) {
      const onInput = options.onInput
      this.input.addEventListener('input', () => onInput(this.input.value))
    }
    this.el = el('div', { class: 'search-box' }, this.input, searchKey())
  }

  /**
   * Take the caret, and select what is there.
   *
   * Selected rather than appended to, because what is in the box is where the
   * reader already is: a caret placed at the end of `IV:400,000-500,000` turns
   * "find GAL4" into `IV:400,000-500,000GAL4`. Typing replaces; an arrow key
   * still keeps the text.
   */
  focus(): void {
    this.input.focus()
    this.input.select()
  }

  /** Put text in the box without telling anybody — a view that has moved. */
  set(text: string): void {
    if (this.input === document.activeElement) return
    this.input.value = text
  }
}

/**
 * The `/` badge, for a box that is built by hand rather than by this class.
 *
 * The genome browser's box is one: it carries a hit list positioned against the
 * same wrapper and a click-to-select gesture of its own, so it stays where it
 * is and borrows the mark.
 */
export function searchKey(): HTMLElement {
  return el('kbd', {
    class: 'kbd search-key',
    text: keyLabel(KEYS.find),
    title: `Press ${keyLabel(KEYS.find)} to put the caret here`,
  })
}
