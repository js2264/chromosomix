/**
 * The inspector's history card (SPECS §33.2, §33.3): every step of the
 * curation in words — row 0 the binning as in the file, then each step, a
 * gesture's steps on one row ending `· 3 steps` — in the names the genomes had
 * when it was made, the whole name as the history keeps it.
 *
 * A press goes there: back, or forward again, every step past it kept to be
 * redone until a new step drops them. The row where the curation stands is in
 * the accent, the steps undone faint; a step a suggestion made, or auto, says
 * so, the suggestion it was in its title.
 *
 * Painted from the store, at once, as a step is made — not when the step has
 * been counted; the rows are rebuilt only when the history itself changes, and
 * an undo or a redo only moves the marks.
 */

import { el } from '../../../ui/dom'
import { fmt } from '../../../units'
import type { CurationEntry } from '../../../genome/curation'
import type { CurationStore } from '../../../state/curation'
import type { CurateChange } from '../../model'
import { historyRows, type HistoryRow } from '../../words'
import type { CurateContext } from '../context'
import { card } from './card'

export interface HistoryOptions {
  /** The curation: its history, where it stands, and whether one kept was refused. */
  store: CurationStore
}

/** A row drawn: the cursor a press puts the history at, and the steps before it. */
interface Drawn {
  node: HTMLElement
  button: HTMLButtonElement
  from: number
  count: number
}

export class HistoryCard {
  readonly element: HTMLElement
  private readonly head: HTMLElement
  private readonly body: HTMLElement
  private readonly list: HTMLOListElement
  private readonly hint: HTMLElement
  private readonly undone: HTMLElement
  private readonly store: CurationStore
  /** The history the rows were made from: rebuilt only when it is another. */
  private rowsOf: { history: readonly CurationEntry[]; rows: HistoryRow[] } | null = null
  /** Where each contig a step moved is in the file, looked up once for every history after. */
  private readonly homes = new Map<string, string | null>()
  private drawn: Drawn[] = []
  private cursorShown = -1
  private frame = 0
  private disposed = false
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly ctx: CurateContext,
    options: HistoryOptions,
  ) {
    this.store = options.store
    const built = card('history')
    this.element = built.element
    this.head = built.head
    this.body = built.body
    this.element.classList.add('curate-history-card')
    this.list = el('ol', { class: 'edit-history curate-history-list', attrs: { 'aria-label': 'The curation’s steps' } })
    this.hint = el('p', { class: 'edit-hint curate-history-hint', text: 'Every step is kept here as it is made: press a row to go back to it, and forward again.' })
    this.undone = el('p', { class: 'edit-note curate-history-undone hidden' })
    const parts: HTMLElement[] = []
    if (this.store.refusal !== null) parts.push(el('p', { class: 'edit-note curate-history-refusal', text: this.store.refusal }))
    parts.push(this.list, this.undone, this.hint)
    this.body.replaceChildren(...parts)
    this.unsubscribe.push(this.store.subscribe(() => this.schedule()))
    this.unsubscribe.push(ctx.model.subscribe((change) => this.update(change)))
    this.paint()
  }

  /** What changed: the history is the store's, heard of at once; a count changes nothing here. */
  update(change: CurateChange): void {
    if (change === 'state') this.schedule()
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    for (const off of this.unsubscribe) off()
  }

  private schedule(): void {
    if (this.disposed) return
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.paint())
  }

  private paint(): void {
    if (this.disposed) return
    const { history, cursor } = this.store.curation
    if (this.rowsOf?.history !== history) {
      this.rowsOf = { history, rows: historyRows(this.store.file, history, this.homes) }
      this.build(this.rowsOf.rows)
      this.cursorShown = -1
    }
    this.head.replaceChildren(history.length === 0 ? 'history' : `history · ${fmt.int(cursor)} of ${fmt.int(history.length)}`)
    this.hint.classList.toggle('hidden', history.length > 0)
    const later = history.length - cursor
    this.undone.classList.toggle('hidden', later === 0)
    this.undone.textContent = later === 0 ? '' : `${later === 1 ? 'A step is' : `${fmt.int(later)} steps are`} undone: press a row to redo up to it, or make a step to drop ${later === 1 ? 'it' : 'them'}.`
    this.mark(cursor)
  }

  /** The rows again, for a history that changed: row 0, then one a step or a gesture. */
  private build(rows: readonly HistoryRow[]): void {
    this.drawn = [this.row(0, 0, 'the binning as in the file', null)]
    for (const row of rows) this.drawn.push(this.row(row.from, row.to, row.text, row))
    this.list.replaceChildren(...this.drawn.map((drawn) => drawn.node))
  }

  private row(from: number, count: number, text: string, row: HistoryRow | null): Drawn {
    const steps = row === null ? 1 : row.to - row.from
    // The words take the row's width, the pill at the top right of them and
    // a gesture's count after them: a whole name wraps at its spaces.
    const words = el('span', { class: 'curate-history-text' })
    if (row !== null && row.by !== 'reader') {
      // A step a suggestion made says so, and what it rested on (§33.2).
      words.appendChild(el('span', { class: 'edit-history-by curate-history-by', text: row.by === 'auto' ? 'auto' : 'suggested', title: row.suggestion ?? (row.by === 'auto' ? 'Taken by auto' : 'Taken from a suggestion') }))
    }
    words.appendChild(el('span', { class: 'curate-history-words', text }))
    if (steps > 1) words.appendChild(el('span', { class: 'curate-history-steps', text: ` · ${fmt.int(steps)} steps` }))
    const button = el(
      'button',
      {
        class: 'edit-history-button curate-history-button',
        attrs: { type: 'button' },
        on: {
          click: () => this.ctx.model.goTo(count),
          pointerenter: () => this.ctx.say(`${count === 0 ? '' : `${fmt.int(count)} · `}${text}${steps > 1 ? ` · ${fmt.int(steps)} steps` : ''}`),
          pointerleave: () => this.ctx.say(null),
        },
      },
      el('span', { class: 'edit-history-n', text: count === 0 ? '·' : fmt.int(count) }),
      words,
    )
    if (row !== null) button.dataset.steps = row.steps.join('\n')
    const node = el('li', { class: 'edit-history-row curate-history-row', attrs: { 'data-count': String(count) } }, button)
    return { node, button, from, count }
  }

  /** Where the curation stands: that row in the accent, the ones after it faint. */
  private mark(cursor: number): void {
    if (cursor === this.cursorShown) return
    this.cursorShown = cursor
    let current: HTMLElement | null = null
    for (const drawn of this.drawn) {
      // A gesture's row holds the cursor when it stands inside it (a record handed in).
      const here = drawn.count === cursor || (drawn.from < cursor && cursor < drawn.count)
      const undone = !here && drawn.count > cursor
      drawn.node.classList.toggle('is-current', here)
      drawn.node.classList.toggle('is-undone', undone)
      drawn.button.setAttribute('aria-current', here ? 'step' : 'false')
      const steps = drawn.button.dataset.steps
      const verb = here ? 'Where the curation stands' : undone ? 'Redo up to here' : 'Go back to here'
      drawn.button.title = steps === undefined || !steps.includes('\n') ? verb : `${verb}:\n${steps}`
      if (here) current = drawn.node
    }
    if (current !== null) this.reveal(current)
  }

  /** Scroll the list, and only the list, so a row is in view. */
  private reveal(node: HTMLElement): void {
    const list = this.list
    const top = node.offsetTop
    const bottom = top + node.offsetHeight
    if (top < list.scrollTop) list.scrollTop = top
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight
  }
}
