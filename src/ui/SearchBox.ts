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

import { button, el } from './dom'
import { KEYS, keyLabel } from './commands'
import { findFeatures, hitLabel } from '../annotations/search'
import type { AnnotationStore } from '../annotations/store'
import { fmt } from './dom'

/** One offered answer: what it reads as, and what it puts in the box. */
export interface Suggestion {
  label: string
  value: string
}

export interface SearchBoxOptions {
  placeholder: string
  /**
   * Draw a bordered `go` beside the box.
   *
   * For the boxes a reader *aims* with rather than types into by reflex — the
   * map's and the browser's locus bars, where the text came from somewhere else
   * and the gesture is paste-then-click. Enter still submits either way; the
   * button is there so that the one thing you can do with the box is visible
   * from across the room, which on a filter box it already is (the list moves as
   * you type) and here it is not.
   */
  go?: boolean
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
  /**
   * What this box can offer for what has been typed so far.
   *
   * Absent for a box with nothing to offer — a table filter answers as you type
   * and has no second list to drop. Given, the box grows a hit list under
   * itself and Enter takes the first hit when the text is not something the
   * view could already act on.
   */
  suggest?(text: string): Suggestion[]
}

export class SearchBox {
  /** The wrapper: the badge is positioned against it, so it goes in the DOM. */
  readonly el: HTMLElement
  readonly input: HTMLInputElement
  private readonly hits = el('div', { class: 'search-hits hidden' })

  constructor(private readonly options: SearchBoxOptions) {
    this.input = el('input', {
      class: `input search-input${options.inputClass === undefined ? '' : ` ${options.inputClass}`}`,
      type: 'text',
      placeholder: options.placeholder,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.value === undefined ? {} : { value: options.value }),
    })
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') this.submit()
      else if (event.key === 'Escape') this.close()
    })
    this.input.addEventListener('input', () => {
      options.onInput?.(this.input.value)
      this.offer()
    })
    // A press on a hit is a `mousedown` before it is a `click`, and the
    // `mousedown` blurs the box — so closing on blur immediately would take the
    // list away before the click landed on anything.
    this.input.addEventListener('blur', () => window.setTimeout(() => this.close(), 150))
    this.el = el(
      'div',
      { class: options.go === true ? 'search-box search-box-go' : 'search-box' },
      this.input,
      searchKey(),
      ...(options.go === true
        ? [button('go', () => this.submit(), { class: 'btn', title: 'Go to what is in the box' })]
        : []),
      ...(options.suggest === undefined ? [] : [this.hits]),
    )
  }

  /**
   * Act on what is in the box: the first hit, or the text itself.
   *
   * The text wins whenever the box has nothing to offer for it, which is what
   * makes coordinates beat names without either being special-cased —
   * `findFeatures` returns nothing for a string with a colon in it, so
   * `chrI:1-2000` is never intercepted by a gene whose name it happens to
   * prefix. Public because the `go` button beside the box means the same thing
   * as Enter, and two spellings of that is how the two come to disagree.
   */
  submit(): void {
    const first = this.offered[0]
    if (first !== undefined) {
      this.input.value = first.value
      this.close()
      this.options.onSubmit(first.value)
      return
    }
    this.close()
    this.options.onSubmit(this.input.value.trim())
  }

  /** What the box is offering right now, in the order it is showing them. */
  private offered: Suggestion[] = []

  private offer(): void {
    const suggest = this.options.suggest
    if (suggest === undefined) return
    this.offered = suggest(this.input.value)
    if (this.offered.length === 0) {
      // Nothing rather than "no match": below two characters and for anything
      // that looks like coordinates the box is not searching at all, and a card
      // saying it failed would be reporting on a search nobody ran.
      this.close()
      return
    }
    this.hits.replaceChildren(
      ...this.offered.map((hit) =>
        button(
          hit.label,
          () => {
            this.input.value = hit.value
            this.close()
            this.options.onSubmit(hit.value)
          },
          { class: 'search-hit' },
        ),
      ),
    )
    this.hits.classList.remove('hidden')
  }

  /**
   * Put the list away, and *empty* it.
   *
   * Hiding alone leaves the buttons live and `offered` populated, so Enter would
   * jump to a hit nobody could see — which makes Escape look like a cancel and
   * behave like a deferred navigation.
   */
  private close(): void {
    this.offered = []
    this.hits.classList.add('hidden')
    this.hits.replaceChildren()
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
 * Feature hits as this box's suggestions, in a **contact map's** coordinates.
 *
 * The base is the whole reason this is written here rather than shared with the
 * browser's list: `metacooler/range.ts` reads a region as 0-based half-open,
 * exactly as `FeatureHit` carries it, while `genome/assembly.ts` reads the
 * browser's loci as 1-based inclusive. One string for both would be off by a
 * base on one of the two, silently and for ever.
 */
export function featureSuggestions(store: AnnotationStore, text: string): Suggestion[] {
  return findFeatures(store, text).map((hit) => ({
    label: `${hitLabel(hit)} · ${hit.contig}:${fmt.int(hit.start)} · ${hit.source}`,
    value: `${hit.contig}:${hit.start}-${hit.end}`,
  }))
}

/** What a locus box says it takes, beyond coordinates. */
export interface LocusAccepts {
  /** A bare sequence name — the whole of one chromosome or contig. */
  sequence?: boolean
  /** A genome's name, on a file that holds more than one. */
  genome?: boolean
  /** A gene or feature name, where an annotation is loaded to search. */
  gene?: boolean
  /** `*`, for everything at once. */
  whole?: boolean
}

/**
 * What a locus box offers, in one sentence, built the same way everywhere.
 *
 * Six boxes across the app asked for the same thing in five different phrasings
 * — `contig, or contig:start-end` in the tables, `genome, contig, or
 * contig:start-end` on one of them, `a genome, or a contig` on the overview,
 * and `chrI:1,000-20,000, a sequence, a gene, or * for the whole genome` in the
 * two browser bars, which named `chrI` on a yeast assembly whose sequences are
 * called `I`. So: one builder, one order, and the *example* is taken from the
 * file in front of the reader rather than from a human genome they may not have
 * open.
 *
 * @param first The assembly's first sequence name, used as the example when it
 * is short enough to leave room for the coordinates — past a dozen characters a
 * scaffold name is the whole box and says less than the word `contig` does.
 */
export function locusPlaceholder(options: { first?: string; accepts?: LocusAccepts }): string {
  const first = options.first !== undefined && options.first.length <= 12 ? options.first : 'contig'
  const accepts = options.accepts ?? {}
  const parts = [`${first}:1,000-20,000`]
  if (accepts.sequence === true) parts.push('a sequence')
  if (accepts.genome === true) parts.push('a genome')
  if (accepts.gene === true) parts.push('a gene')
  const listed = parts.join(', ')
  return accepts.whole === true ? `${listed}, or * for the whole genome` : listed
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
