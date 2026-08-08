/**
 * The two `+` edges a deck is drawn with, before there is a deck (§16.9).
 *
 * The feature this fixes is not a missing button; it is that nothing on screen
 * said the deck existed. A companion could only be reached through the command
 * palette, so a reader who had never read the changelog had no way to find out
 * that this viewer puts N maps side by side — and the one gesture they would
 * try, dropping a second cooler on the map, means *load a track* here (§8.3).
 *
 * The obvious repair is a drop strip down the right of the map that takes a file
 * straight into a new panel, and it is the wrong one. Adding maps one at a time
 * makes the **arrangement** a consequence of the order the files arrived in,
 * and the arrangement is the thing a reader assembling a figure is actually
 * composing: two conditions across and two timepoints down is a statement, and
 * reaching it by dropping four files into a row and then pressing `◀` is not
 * composing it, it is repairing it.
 *
 * So `+` opens a **cell**, not a map. Pressing the one beside the map turns a
 * single map into two cells with the reader's own file in the first; pressing
 * the one below it puts a row underneath. What appears is the deck they drew,
 * with every cell they have not filled standing as its own drop target — as
 * many drop areas as they asked for, each in the position the map will occupy.
 * Filling them is then in any order, or never: an empty cell is a legitimate
 * thing for a deck to have, and `~` already carries one through a link (§16.6).
 *
 * The frame is one component and two owners, which is deliberate. Before there
 * is a deck it wraps the session's own view; afterwards it wraps the deck's
 * grid. Two implementations would be two sets of edges that drift apart, and
 * the whole point of the gesture is that it is the same one in both places —
 * pressing `+` on a deck of four is the same act as pressing it on a map of
 * one, and the reader should not be able to tell that one of them built a
 * `PanelDeck` on the way.
 */

import { el } from '../ui/dom'
import { icon } from '../ui/icons'
import type { GrowDirection } from './deck'

export interface DeckFrameProps {
  /** `+` was pressed, or a file was dropped on an edge with nothing to fill. */
  onGrow(direction: GrowDirection, file?: File): void
}

/**
 * The tooltip each edge carries, which is also the whole of the feature's
 * documentation for a reader who never opens a changelog.
 */
const NOTES: Record<GrowDirection, string> = {
  beside:
    'Open a cell beside this map. The maps stay where they are and a column of empty cards ' +
    'appears next to them — drop a cooler on one, or drop a file here, to fill it. Every map in ' +
    'a deck shows the same region and moves with the others (§16).',
  below:
    'Open a row of cells below these maps. Same navigation, same region, one row further down — ' +
    'which is the arrangement for a second condition rather than a second sample.',
}

export class DeckFrame {
  readonly el: HTMLElement
  private readonly body = el('div', { class: 'deck-frame-body' })
  private readonly edges: Record<GrowDirection, HTMLButtonElement>
  private readonly room: Record<GrowDirection, boolean> = { beside: true, below: true }

  constructor(private readonly props: DeckFrameProps) {
    this.edges = {
      beside: this.edge('beside'),
      below: this.edge('below'),
    }
    this.el = el('div', { class: 'deck-frame' }, this.body, this.edges.beside, this.edges.below)
  }

  /**
   * Put `node` in the frame and hand back the element to mount.
   *
   * The same shape as `PanelDeck.frame`, and re-parenting for the same reason:
   * the node is a mounted view or a live grid of canvases, and rebuilding it to
   * change what it hangs from would make a `+` cost a read.
   */
  hold(node: HTMLElement): HTMLElement {
    this.body.replaceChildren(node)
    return this.el
  }

  /**
   * Which edges can still open a cell (§16.7's ceiling), and what to say if not.
   *
   * **Per edge**, because the two do not run out together: a deck of two rows
   * and two columns has room for a third row of two and not for a third column
   * of two if that would be the seventh panel — a single "full" would grey an
   * edge that works or offer one that does not.
   *
   * Greyed rather than removed, for the reason the turn's control is: a reader
   * who has hit the limit should be told there is one, and an affordance that
   * silently disappears at six maps reads as a fault in the fifth. Greyed with
   * `aria-disabled` rather than `disabled`, because a `disabled` button is not a
   * drop target in every browser and a **drop is still accepted here** — see
   * {@link edge}.
   */
  setRoom(room: Record<GrowDirection, boolean>, note: string): void {
    for (const direction of ['beside', 'below'] as const) {
      const edge = this.edges[direction]
      this.room[direction] = room[direction]
      edge.classList.toggle('is-disabled', !room[direction])
      edge.title = room[direction] ? NOTES[direction] : note
      edge.setAttribute('aria-label', edge.title)
      edge.setAttribute('aria-disabled', String(!room[direction]))
    }
  }

  private edge(direction: GrowDirection): HTMLButtonElement {
    const node = el('button', {
      class: `deck-grow deck-drop is-${direction}`,
      title: NOTES[direction],
      type: 'button',
      attrs: { 'aria-label': NOTES[direction], 'aria-disabled': 'false' },
    })
    node.append(icon('plus', { size: 16 }))
    node.addEventListener('click', () => {
      if (this.room[direction]) this.props.onGrow(direction)
    })

    // A file dropped on an edge is the gesture the strip in §3.1's A1 was going
    // to be, kept because it is what a reader tries first: it opens the cell and
    // fills it in one movement. `dragover` has to preventDefault or the drop
    // never fires; `.deck-drop` is what keeps the content area's own importer
    // off it, since that one would otherwise take the same file and load it as
    // a track over the lead (`App.ts`).
    //
    // Accepted **even with no room for a cell**, and deliberately: `.deck-drop`
    // has already taken this drop away from the content area, so refusing it
    // here would put the file on the floor without a word. The deck answers
    // instead — it opens the cell where it can, puts the map in an empty one
    // where it cannot, and says why when it can do neither.
    node.addEventListener('dragover', (event) => {
      if (event.dataTransfer === null) return
      event.preventDefault()
      node.classList.add('over')
    })
    node.addEventListener('dragleave', () => node.classList.remove('over'))
    node.addEventListener('drop', (event) => {
      node.classList.remove('over')
      const file = event.dataTransfer?.files?.[0]
      if (file === undefined) return
      event.preventDefault()
      this.props.onGrow(direction, file)
    })
    return node
  }
}
