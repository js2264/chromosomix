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
import { dragHasFileRow, readFileDrag } from '../ui/fileDrag'
import type { PickedFile } from '../browse/folder'
import type { GrowDirection } from './deck'

export interface DeckFrameProps {
  /** `+` was pressed, or a file was dropped on an edge with nothing to fill. */
  onGrow(direction: GrowDirection, picked?: PickedFile): void
}

/** What the cells an edge opens may hold, which is what its note is worded from. */
export type DeckHolds = 'maps' | 'cells'

/**
 * The tooltip each edge carries, which is also the whole of the feature's
 * documentation for a reader who never opens a changelog.
 *
 * Worded from **what the deck this edge would grow can hold**, because one
 * wording could not be true of both. It said *drop a cooler on one* wherever it
 * appeared, and beside the 1D browser that invites the one act such a deck
 * refuses (§25 stage D): its cells are a structure and stacks of tracks, and a
 * map there opens as a session of its own. The frame the session puts round a
 * view before there is a deck does not know which it will be, so it names
 * neither kind and says the half that is true either way.
 *
 * Two sentences at most, and no section numbers: a note read off the end of a
 * cursor is read in a second (§26.4).
 */
function notes(holds: DeckHolds | undefined): Record<GrowDirection, string> {
  if (holds === 'maps') {
    return {
      beside:
        'Open a cell beside these maps — drop a cooler on it, or drop a file here, to fill it. ' +
        'Every map in a deck shows the same region and moves with the others.',
      below:
        'Open a row of cells below these maps, which is the arrangement for a second condition ' +
        'rather than a second sample.',
    }
  }
  if (holds === 'cells') {
    return {
      beside:
        'Open a cell beside these — for the 3D structure, or another stack of tracks. A map opens ' +
        'as a session of its own.',
      below:
        'Open a row of cells below these — for the 3D structure, or another stack of tracks. A ' +
        'map opens as a session of its own.',
    }
  }
  return {
    beside:
      'Open a cell beside this one. What is on screen stays where it is and a card appears ' +
      'beside it — drop a file on the card, or here, to fill it.',
    below:
      'Open a row of cells below this one. Same navigation, same place, one row further down.',
  }
}

export class DeckFrame {
  readonly el: HTMLElement
  private readonly body = el('div', { class: 'deck-frame-body' })
  private readonly edges: Record<GrowDirection, HTMLButtonElement>
  private readonly room: Record<GrowDirection, boolean> = { beside: true, below: true }
  /**
   * What the cells these edges open may hold, once somebody knows.
   *
   * Pushed by the deck ({@link setHolds}) rather than asked of it, because the
   * frame outlives every lead it frames: the session hands it a map's view, a
   * browser's, and a map's again, and a note written once would describe
   * whichever was first. `undefined` until then — see {@link notes}.
   */
  private holds: DeckHolds | undefined
  /** The refusal {@link setRoom} last gave, so a note can be written again. */
  private refusal = ''

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
   * Let go of whatever is being held, for a frame that is going off screen.
   *
   * The frame outlives what it frames — the session keeps one for the whole of
   * its life — so a view mounted without it (a table, §16.8) leaves the frame
   * detached with the *previous* view still parented inside it. That view has
   * been destroyed, but its subtree has not been dropped, and a heatmap's
   * subtree is a canvas with a full-resolution backing store in it.
   */
  release(): void {
    this.body.replaceChildren()
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
    this.refusal = note
    for (const direction of ['beside', 'below'] as const) {
      this.room[direction] = room[direction]
      this.edges[direction].classList.toggle('is-disabled', !room[direction])
      this.edges[direction].setAttribute('aria-disabled', String(!room[direction]))
      this.paintNote(direction)
    }
  }

  /**
   * What the cells these edges would open can hold (§25 stage D).
   *
   * Told on every paint of the deck's bar, which is every render: a session
   * moves between a map lead and the browser with the deck intact, and the edge
   * that invites a cooler beside the maps must not go on inviting one beside a
   * browser that has to refuse it.
   */
  setHolds(holds: DeckHolds): void {
    if (this.holds === holds) return
    this.holds = holds
    this.paintNote('beside')
    this.paintNote('below')
  }

  /** The note on one edge: what it opens, or why it cannot. */
  private paintNote(direction: GrowDirection): void {
    const edge = this.edges[direction]
    edge.title = this.room[direction] ? notes(this.holds)[direction] : this.refusal
    edge.setAttribute('aria-label', edge.title)
  }

  private edge(direction: GrowDirection): HTMLButtonElement {
    const note = notes(undefined)[direction]
    const node = el('button', {
      class: `deck-grow deck-drop is-${direction}`,
      title: note,
      type: 'button',
      attrs: { 'aria-label': note, 'aria-disabled': 'false' },
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
      // A row dragged out of the Files panel, which is the same instruction with
      // the bytes somewhere else — and is the drop this edge would otherwise
      // *swallow*: `.deck-drop` has already taken it away from the content
      // area's importer, so failing to answer here puts the file on the floor
      // without a word. Resolved first because it costs a fetch and the branch
      // below reads a list that is already in hand.
      if (dragHasFileRow(event)) {
        event.preventDefault()
        void readFileDrag(event).then((picked) => {
          if (picked !== null) this.props.onGrow(direction, picked)
        })
        return
      }
      const file = event.dataTransfer?.files?.[0]
      if (file === undefined) return
      event.preventDefault()
      this.props.onGrow(direction, { uri: file.name, source: { kind: 'local', file } })
    })
    return node
  }
}
