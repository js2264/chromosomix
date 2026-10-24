/**
 * The contact maps this session is holding: one, or two, or none on screen.
 *
 * It lives at the top of the Annotations column rather than in General, and the
 * placement is the argument: everything in that column is *something laid over
 * this genome*, and a contact matrix is the largest thing anyone can lay over
 * one. General describes the file; this is a thing you do with it.
 *
 * Which is also why each map wears the same **eye** a track's row wears. Hiding
 * the first one is what the 1D genome browser *is* — the same tracks, the same
 * store, the same window, with the matrix taken out of the picture — and the
 * map stays open behind it, so the trip back costs nothing but the eye again.
 * Two controls for two different acts, on the same row: the eye puts a map down
 * and the × lets go of it.
 *
 * The card is also the whole of the comparison's interface. What it refuses, it
 * refuses here with the reason — same contigs, same bin size, cooler only — and
 * what it accepts it reports in one line. The map does the rest.
 */

import { alignNames, type Alignment, type NamedSequence } from '../genome/naming'

import { MAP_ROW_DRAG_TYPE, button, dragHasFiles, dropEffectFor, el, fmt, type MapRow } from './dom'
import { tabAmong } from './tabWalk'
import { dragHasFileRow } from './fileDrag'
import { cardTitle, icon, iconButton } from './icons'
import type { OpenResult } from '../worker/protocol'
import { fileLabel } from './labels'

/** What the card is showing right now. */
export type CompareState =
  | { kind: 'empty' }
  | { kind: 'loading'; label: string }
  | { kind: 'error'; label: string; message: string }
  | { kind: 'open'; label: string; info: OpenResult }

/**
 * A map of the deck's other cells as its row lists it (§16.9) — or one the
 * reader's eye took out of the deck, which the session holds hidden until the
 * eye opens it again (`shown: false`).
 */
export interface DeckMapRow {
  id: string
  label: string
  uri: string
  /** Absent is shown: a map in a cell. */
  shown?: boolean
}

export interface CompareCardProps {
  /** A file was dropped or a URL typed. */
  onOpen(source: { kind: 'local'; file: File } | { kind: 'remote'; url: string }): void
  /**
   * A row out of the Files panel, dropped on a slot — the lower triangle's, or
   * the first map's where there is none (§20.5).
   *
   * The *event* rather than a file, as on the Tracks card: the bytes behind
   * the row have not been fetched, and a drop handler cannot await. Absent,
   * such a drop is not offered.
   */
  onPickDropped?(event: DragEvent): void
  /**
   * Take the matrix out of the picture, or put it back — the eye on a row.
   *
   * `1` is this session's own map, and hiding it *is* the 1D browser; `2` is the
   * second file, whose eye takes the lower-left triangle away and leaves the
   * upper one, which is the same map on its own.
   */
  onToggleShown(which: 1 | 2): void
  /** Whether each map is currently drawn. */
  isShown(which: 1 | 2): boolean
  /**
   * Whether this session's own map stands in a deck beside other cells, where
   * its eye takes its **cell** off the screen and puts it back, as every other
   * map's eye does (§16.9), rather than putting the map down for the 1D
   * browser. Absent is no deck.
   */
  primaryInDeck?(): boolean
  /**
   * Put one of the two down and go back to a single map.
   *
   * Either one: closing the second leaves the first as it was, and closing the
   * first opens the second on its own — which is what a × beside a name has to
   * mean when there are two names, and is the same pair of actions the two File
   * cards in General already offer.
   */
  onClose(which: 1 | 2): void
  /** Swap which file is above the diagonal. */
  onSwap(): void
  /** What to call the map already open — the reader's name for it, or its file's. */
  primaryLabel(): string
  /**
   * What to call the second map. `undefined` before there is one.
   *
   * Asked of the session rather than taken from {@link CompareState}, which
   * carries the file's own label: a map can be renamed, and the names belong to
   * the session that is holding the maps (`ui/mapNames.ts`).
   */
  secondLabel?(): string | undefined
  /**
   * The reader typed a name into one of the two rows, or emptied the box.
   *
   * `null` is the empty box, which hands the map back to its file name — the
   * same rule that makes renaming a tab or a track undoable.
   */
  onRename?(which: 1 | 2, name: string | null): void
  /**
   * Whether there is a map open at all.
   *
   * `false` is a 1D browser that was started from a track, where this card is
   * the *first* slot rather than the second — no rows, and a drop area that
   * asks for a contact map rather than for one to compare against. It is here
   * for the same reason it is here with a map open: the column that lists what
   * is drawn over this genome is where a reader goes to add something to it.
   */
  hasPrimary(): boolean
  /**
   * The maps in the deck's other cells, in grid order (§16.9) — every map the
   * session is holding is a row here, not only the one it is of and the one in
   * its lower triangle. Absent, or empty, where there is no deck.
   */
  deckMaps?(): ReadonlyArray<DeckMapRow>
  /**
   * The eye on a deck map's row, as the eye on a Structures row: a map in a
   * cell is taken out of the deck and held here, hidden; a hidden one is
   * opened in a cell again.
   */
  onToggleDeckMap?(id: string): void
  /**
   * Whether a hidden map could be opened in a cell now — `false` in a view no
   * deck frames (§16.8), where the eye would have nowhere to put it.
   */
  deckMapsShowable?(): boolean
  /** The × on a deck map's row: take that cell out of the deck, or let a hidden map go. */
  onCloseDeckMap?(id: string): void
  /** A name typed into a deck map's row, or the box emptied. */
  onRenameDeckMap?(uri: string, name: string | null): void
  /**
   * A row's grip was taken hold of, or let go — the deck shows its tiling while
   * a map is looking for a cell, as it does for a cell's own grip.
   */
  onDragMap?(dragging: boolean): void
  /**
   * How many of {@link deckMaps}' shown maps stand before this session's own in
   * the grid, so the card lists every map in the grid's order (§16.9): the first
   * map's row — and the compared map's under it, the one square — where its cell
   * stands rather than always first. Absent is first.
   */
  leadAt?(): number
  /**
   * A map's row was dragged up or down the card, or moved by the arrow keys on
   * its grip: put its cell before or after another map's (§16.9). {@link LEAD_ROW}
   * is this session's own map, and every other id is a deck map's.
   */
  onReorderMap?(map: string, onto: string, after: boolean): void
}

/** The id the card's reorder speaks of this session's own map by. */
export const LEAD_ROW = 'lead'

export class CompareCard {
  readonly el: HTMLElement
  private readonly body = el('div', { class: 'ann-list compare-body' })
  private readonly slots: [DropSlot, DropSlot]
  private state: CompareState = { kind: 'empty' }
  /**
   * The map whose row is being dragged, where it is one the card can reorder —
   * held here rather than read off the drag, which a `dragover` cannot, and
   * which lets a drag survive the card redrawing under it.
   */
  private dragging: string | null = null
  /** The maps the card lists in the grid's order, by the ids a reorder uses. */
  private order: string[] = []
  /** The grip a keyboard move asked for, focused again once the card redraws. */
  private refocus: string | null = null

  constructor(private readonly props: CompareCardProps) {
    // One zone per slot, built once and reworded per render: which map a
    // rectangle asks for is a fact about the session that changes under it, and
    // rebuilding the element per frame would drop a drag in progress.
    this.slots = [this.dropSlot(), this.dropSlot()]
    this.el = el(
      'div',
      { class: 'card compare-card' },
      cardTitle('Contact maps', 'grid-2x2'),
      this.body,
      // **No second door on this card.** It held a box to paste a URL into and,
      // beside it, a button onto the places this window is connected to. Both
      // have gone: what a card that asks for a file needs is the drop zone above
      // and nothing else, and every road *into* a connected folder still runs
      // through the Files column (§20), which is where a reader goes to browse
      // one and where the same pick lands.
    )
    this.render()
  }

  set(state: CompareState): void {
    this.state = state
    this.render()
  }

  /**
   * Redraw from what the session says now, without changing what is loaded.
   *
   * The eyes read the session rather than this card — which map is on screen is
   * a fact about the session and about nothing else — so the card has to be told
   * when that changes. `set` is for the *second file*'s own state and would
   * throw the loading and error phases away if it were used for this.
   */
  sync(): void {
    this.render()
  }

  /**
   * Two slots, each either a map or a rectangle to put one on.
   *
   * The Tracks card's shape, to the class: a list of `.ann-row`s over a
   * `.ann-drop`, with the connected-places button underneath. The two cards ask the
   * same thing of a reader — *put a file here*, then *here is what is in* — and
   * a card that answered it in its own vocabulary was a second application in
   * the same column. It is also what makes the controls on a row look like the
   * controls on a track's row, since the rules that take the borders off them
   * are written against `.ann-row.ann-ready`.
   */
  private render(): void {
    const paired = this.state.kind === 'open'
    const first = this.props.hasPrimary()
    this.slots[0].label.textContent = 'Load a contact map'
    this.slots[0].hint.textContent = 'A .cool or .mcool. Drop one here, or click to choose.'
    // *Into the lower triangle*, rather than *a second map*: the deck's own
    // second map is a cell beside this one (§16), and a reader told by HiCRep to
    // open a second map had this card as the first thing in the column. The two
    // are different pictures and now say so. The same last sentence as the zone
    // above it, because they are the same gesture (§20.2).
    this.slots[1].label.textContent = 'Load a map into the lower triangle'
    this.slots[1].hint.textContent =
      'A cooler on the same chromosomes and bin size. Drop one here, or click to choose.'

    const top = first
      ? this.mapRow(1, this.props.primaryLabel(), paired)
      : this.slots[0].zone
    // **No second slot until there is a first.** With no map open the card drew
    // both rectangles, one under the other, calling the second one a *second
    // map* that would fill *the lower-left triangle* — of nothing. A reader with
    // one `.cool` in hand had two identical-looking targets to choose between
    // and a triangle to wonder about, and either target opened the same file the
    // same way. §8.5's rule is that a control the file cannot answer is absent,
    // and this one cannot be answered until a map is on screen to be compared
    // against.
    const bottom =
      this.state.kind === 'open'
        ? this.mapRow(2, this.props.secondLabel?.() ?? this.state.label, true)
        : this.state.kind === 'loading'
          ? this.pendingRow('loading', `Opening ${this.state.label}…`)
          : this.state.kind === 'error'
            ? this.pendingRow('error', this.state.message)
            : first
              ? this.slots[1].zone
              : null
    // Every other map the session holds, one row each, **in the order the grid
    // holds them** — the first map's square among them where its cell stands,
    // with the map compared against it under it, which is the one square; the
    // hidden maps after the shown ones, having no cell to be in the order of;
    // and the rectangle that asks for a second file last, being about that
    // square too.
    const maps = first ? (this.props.deckMaps?.() ?? []) : []
    const shownMaps = maps.filter((map) => map.shown !== false)
    const hiddenMaps = maps.filter((map) => map.shown === false)
    const at = Math.max(0, Math.min(shownMaps.length, Math.floor(this.props.leadAt?.() ?? 0)))
    const open = this.state.kind !== 'empty' || !first
    const square = [
      this.reorderable(top, first ? LEAD_ROW : null),
      ...(open && bottom !== null ? [this.reorderable(bottom, first ? LEAD_ROW : null)] : []),
    ]
    this.order = first
      ? [...shownMaps.slice(0, at).map((map) => map.id), LEAD_ROW, ...shownMaps.slice(at).map((map) => map.id)]
      : []
    this.body.replaceChildren(
      ...shownMaps.slice(0, at).map((map) => this.reorderable(this.deckRow(map), map.id)),
      ...square,
      ...shownMaps.slice(at).map((map) => this.reorderable(this.deckRow(map), map.id)),
      ...hiddenMaps.map((map) => this.deckRow(map)),
      ...(!open && bottom !== null ? [bottom] : []),
    )
    const wanted = this.refocus
    this.refocus = null
    if (wanted !== null) {
      const row = [...this.body.querySelectorAll<HTMLElement>('.compare-row')].find(
        (node) => node.dataset['map'] === wanted,
      )
      row?.querySelector<HTMLElement>('.compare-grip')?.focus()
    }
  }

  /**
   * A map's row as a place another map's row can be dropped: above its middle
   * puts the dragged map before it, below its middle after it (§16.9). The
   * compared map's row is the first map's square too, so a drop on it is one on
   * the first map. `null` is a row that is no map — the drop rectangles — and
   * is returned as it came.
   */
  private reorderable(row: HTMLElement, id: string | null): HTMLElement {
    if (id === null || this.props.onReorderMap === undefined) return row
    row.dataset['map'] = id
    const after = (event: DragEvent): boolean => {
      const box = row.getBoundingClientRect()
      return event.clientY >= box.top + box.height / 2
    }
    row.addEventListener('dragover', (event) => {
      if (this.dragging === null || this.dragging === id) return
      // Without this the drop is refused and the ghost springs back.
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer, 'move')
      this.clearDropMarks()
      row.classList.add(after(event) ? 'drop-after' : 'drop-before')
    })
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'))
    row.addEventListener('drop', (event) => {
      const moved = this.dragging
      this.clearDropMarks()
      if (moved === null || moved === id) return
      event.preventDefault()
      this.dragging = null
      this.props.onReorderMap?.(moved, id, after(event))
    })
    return row
  }

  private clearDropMarks(): void {
    for (const node of this.body.querySelectorAll('.drop-before, .drop-after')) {
      node.classList.remove('drop-before', 'drop-after')
    }
  }

  /**
   * The handle a map is dragged into a cell of the deck by (§16.9).
   *
   * Every row has one, the first map's included: dropped on an empty cell, the
   * first map or the compared file opens a second picture of itself there — the
   * plainest way to read one file at two windows or two colour scales — and a
   * companion's own row moves that companion, as the grip on its cell does.
   */
  private grip(row: MapRow, label: string): HTMLElement {
    // The maps a drag up or down the card moves: the first map and every map in
    // a cell. The compared map is the first map's square and moves with it; a
    // hidden map has no cell to move.
    const reorder =
      this.props.onReorderMap === undefined
        ? null
        : row.kind === 'lead'
          ? LEAD_ROW
          : row.kind === 'companion'
            ? row.id
            : null
    const node = el('span', {
      class: 'ann-grip compare-grip',
      title:
        row.kind === 'companion'
          ? `Drag ${label} up or down this card, or to another cell of the deck`
          : row.kind === 'hidden'
            ? `Drag ${label} onto an empty cell, or a + beside the map, to open it there`
            : row.kind === 'lead' && reorder !== null
              ? `Drag ${label} up or down this card to move its cell, or onto an empty cell or a + to open it there too`
              : `Drag ${label} onto an empty cell, or a + beside the map, to open it there too`,
      attrs: {
        draggable: 'true',
        role: 'button',
        'aria-label': reorder === null ? `Move ${label} to a cell` : `Move ${label} to a cell; the arrow keys move it up or down`,
        ...(reorder === null ? {} : { tabindex: '0' }),
      },
    })
    node.append(icon('grip-vertical', { size: 12 }))
    if (reorder !== null) {
      // The keyboard's road, the Tracks card's: up and down past its neighbour.
      node.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        const at = this.order.indexOf(reorder)
        const up = event.key === 'ArrowUp'
        const neighbour = this.order[at + (up ? -1 : 1)]
        if (at < 0 || neighbour === undefined) return
        this.refocus = reorder
        this.props.onReorderMap?.(reorder, neighbour, !up)
      })
    }
    node.addEventListener('dragstart', (event) => {
      this.dragging = reorder
      node.closest('.ann-row')?.classList.add('is-dragging')
      if (event.dataTransfer !== null) {
        // Both, whichever the row is: each target names its own effect — the
        // grid a move, an empty cell and an edge a copy — and a drag whose
        // allowed effects do not include the one its target names is a drop
        // the browser refuses without a word.
        event.dataTransfer.effectAllowed = 'copyMove'
        event.dataTransfer.setData('text/plain', label)
        event.dataTransfer.setData(MAP_ROW_DRAG_TYPE, JSON.stringify(row))
        const whole = node.closest('.ann-row')
        if (whole instanceof HTMLElement) event.dataTransfer.setDragImage(whole, 12, 12)
      }
      this.props.onDragMap?.(true)
    })
    node.addEventListener('dragend', () => {
      this.dragging = null
      node.closest('.ann-row')?.classList.remove('is-dragging')
      this.clearDropMarks()
      this.props.onDragMap?.(false)
    })
    return node
  }

  /**
   * One map in another cell of the deck: its grip, its name, its eye and its ×.
   *
   * The eye means what it means on a Structures row (§25.3): lit, the map is in
   * a cell, and pressing it closes that cell and keeps the map here; dark, the
   * map is held here and pressing it opens a cell for it again. The × lets go —
   * of the cell, or of the hidden map — so the two acts a track's row separates
   * are separate here as well.
   */
  private deckRow(map: DeckMapRow): HTMLElement {
    const shown = map.shown !== false
    const rename = this.props.onRenameDeckMap
    const name =
      rename === undefined
        ? el('span', { class: 'ann-name ann-name-static', text: map.label, title: map.uri })
        : this.nameBox(map.label, `${map.uri} — click to rename`, (typed) => rename(map.uri, typed))
    const showable = shown || (this.props.deckMapsShowable?.() ?? true)
    const eye = iconButton(
      shown ? 'eye' : 'eye-off',
      shown
        ? `Close ${map.label}'s cell, keeping the map here — the eye opens it again`
        : showable
          ? `Open ${map.label} in a cell of the deck again`
          : `${map.label} opens in a cell of a deck, and this view has none`,
      () => this.props.onToggleDeckMap?.(map.id),
      { class: 'btn btn-icon ann-eye', size: 14 },
    )
    eye.setAttribute('aria-pressed', String(shown))
    if (!showable) eye.disabled = true
    return el(
      'div',
      { class: `ann-row ann-ready compare-row compare-deck-row${shown ? '' : ' is-parked'}` },
      el(
        'div',
        { class: 'ann-head' },
        this.grip(shown ? { kind: 'companion', id: map.id } : { kind: 'hidden', id: map.id }, map.label),
        name,
        ...(this.props.onToggleDeckMap === undefined ? [] : [eye]),
        iconButton(
          'x',
          // The card's × is the one that lets go: the × on the map's own cell
          // only hides it, back onto this list (§16.9).
          shown ? `Let go of ${map.label}: its cell closes and it leaves this list` : `Let go of ${map.label}`,
          () => this.props.onCloseDeckMap?.(map.id),
          { class: 'btn-close', size: 14 },
        ),
      ),
    )
  }

  /**
   * One map: which triangle it is in, what it is called, and the two things a
   * reader does to it.
   *
   * The same three-part head a track's row has, in the same order — a mark, a
   * name, then the eye and the ×. That is not imitation for its own sake: a map
   * and a track are both things drawn over this genome, and a reader who has
   * learned that the eye takes one out of the picture has learned it for both.
   *
   * The triangle marks appear only when there are two files, because with one
   * there is no diagonal to be on a side of.
   */
  private mapRow(which: 1 | 2, label: string, paired: boolean): HTMLElement {
    const shown = this.props.isShown(which)
    const inDeck = which === 1 && this.props.primaryInDeck?.() === true
    const eye = iconButton(
      shown ? 'eye' : 'eye-off',
      which === 1
        ? inDeck
          ? shown
            ? `Close ${label}'s cell, keeping the map here — the eye opens it again`
            : `Open ${label}'s cell in the deck again, where it stood`
          : shown
            ? 'Hide the map and read this genome as tracks. It stays open — the eye brings it back.'
            : 'Draw the map again, where it was left'
        : shown
          ? 'Take the lower-left triangle out of the picture, keeping the file open'
          : 'Draw the second map again',
      () => this.props.onToggleShown(which),
      { class: 'btn btn-icon ann-eye', size: 14 },
    )
    eye.setAttribute('aria-pressed', String(shown))
    return el(
      'div',
      // Dimmed while its cell is off the screen, as a hidden companion's row is.
      { class: `ann-row ann-ready compare-row${inDeck && !shown ? ' is-parked' : ''}` },
      el(
        'div',
        { class: 'ann-head' },
        this.grip({ kind: which === 1 ? 'lead' : 'compare' }, label),
        ...(paired
          ? [
              el('span', {
                class: `compare-mark ${which === 1 ? 'compare-upper' : 'compare-lower'}`,
                text: which === 1 ? '◥' : '◣',
              }),
            ]
          : []),
        this.name(which, label, paired),
        eye,
        iconButton(
          'x',
          paired
            ? which === 1
              ? `Close ${label} and keep the other map on its own`
              : `Close ${label} and go back to one map`
            : `Close ${label} and keep browsing its genome as tracks`,
          () => this.props.onClose(which),
          { class: 'btn-close', size: 14 },
        ),
      ),
      ...(paired && which === 2 && this.state.kind === 'open'
        ? [
            el('p', {
              class: 'ann-note',
              text:
                `${fmt.int(this.state.info.nContigs)} chromosomes · ` +
                `${fmt.int(this.state.info.binsize ?? 0)} bp bins · ` +
                `${fmt.bytes(this.state.info.sourceBytes)}`,
            }),
            button('swap sides', () => this.props.onSwap(), {
              class: 'btn btn-quiet btn-wide',
              title:
                'Put the other file above the diagonal. The comparison is the same; which map ' +
                'the eye reads first is not.',
            }),
          ]
        : []),
    )
  }

  /**
   * What a map is called, on this row and everywhere else it is named.
   *
   * The Tracks card's own control, to the class: an `<input>` that looks like
   * text until it has the caret, rather than a label that swaps itself for one.
   * The argument is the same argument, and it is stronger here — a file name is
   * a starting point rather than an answer, and two conditions being compared
   * are `mat_G1.mcool::1000` and `mat_G2M.mcool::1000`, whose two informative
   * characters are the last thing anybody reads.
   *
   * An empty box hands the map back to its file name, which is what makes the
   * rename undoable; a session with no rename offered ({@link
   * CompareCardProps.onRename} absent) keeps the plain text it always had.
   */
  private name(which: 1 | 2, label: string, paired: boolean): HTMLElement {
    const rename = this.props.onRename
    const where = paired
      ? which === 1
        ? 'Upper-right triangle, and the upper band of a turned pair'
        : 'Lower-left triangle, and the lower band of a turned pair'
      : label
    if (rename === undefined) {
      return el('span', { class: 'ann-name ann-name-static', text: label, title: where })
    }
    return this.nameBox(label, `${where} — click to rename`, (typed) => rename(which, typed))
  }

  /** The Tracks card's rename box, for a map's row. */
  private nameBox(label: string, title: string, onRename: (name: string | null) => void): HTMLInputElement {
    const input = el('input', {
      class: 'input ann-name',
      type: 'text',
      value: label,
      title,
    })
    input.addEventListener('change', () => {
      const typed = input.value.trim()
      if (typed === label) {
        input.value = label
        return
      }
      onRename(typed === '' ? null : typed)
    })
    input.addEventListener('keydown', (event) => {
      // Enter that goes on to the next row's name, Shift+Tab the one before (§26.8).
      if (tabAmong(event, input, '.ann-list', 'input.ann-name')) return
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        input.value = label
        input.blur()
      }
    })
    return input
  }

  /** The second slot while its file is being read, or after it was refused. */
  private pendingRow(kind: 'loading' | 'error', message: string): HTMLElement {
    return el(
      'div',
      { class: `ann-row ann-${kind}` },
      el('p', {
        class: kind === 'error' ? 'inline-error ann-note' : 'ann-note',
        text: message,
      }),
      ...(kind === 'error'
        ? [
            button('try another file', () => this.set({ kind: 'empty' }), {
              class: 'btn btn-quiet',
            }),
          ]
        : []),
    )
  }

  /** A rectangle a map is dropped on, with its own file input. */
  private dropSlot(): DropSlot {
    const label = el('span', { class: 'ann-drop-label' })
    const hint = el('span', { class: 'ann-drop-hint' })
    const zone = el('div', { class: 'ann-drop', attrs: { tabindex: '0', role: 'button' } }, label, hint)
    const fileInput = el('input', { class: 'hidden-input', type: 'file' })
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      if (file) this.props.onOpen({ kind: 'local', file })
    })
    zone.appendChild(fileInput)
    zone.addEventListener('click', (event) => {
      if (event.target !== fileInput) fileInput.click()
    })
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') fileInput.click()
    })
    // A file, or a row out of the Files panel, which is the same gesture with
    // the bytes still in the folder. Nothing else is offered the slot: it lit
    // for this card's own grips, and let a dragged row fall into it for nothing.
    const takesRow = (event: DragEvent): boolean =>
      this.props.onPickDropped !== undefined && dragHasFileRow(event)
    zone.addEventListener('dragover', (event) => {
      if (!dragHasFiles(event) && !takesRow(event)) return
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = dropEffectFor(event.dataTransfer, 'copy')
      zone.classList.add('over')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('over'))
    zone.addEventListener('drop', (event) => {
      event.preventDefault()
      zone.classList.remove('over')
      if (takesRow(event)) {
        // Read in this handler, where the payload is still readable, and opened
        // by the session once the folder has handed the file over.
        this.props.onPickDropped?.(event)
        return
      }
      const file = event.dataTransfer?.files?.[0]
      if (file) this.props.onOpen({ kind: 'local', file })
    })
    return { zone, label, hint }
  }
}

/** A drop rectangle and the two lines written in it. */
interface DropSlot {
  zone: HTMLElement
  label: HTMLElement
  hint: HTMLElement
}


/**
 * Why these two files cannot be drawn in one square, or `null` when they can.
 *
 * Every clause is a way the picture would be a lie rather than a limitation of
 * the code, which is why each one names the thing that differs instead of
 * refusing generically:
 *
 * - **A genome layer.** A metacool's axis is contigs from thousands of
 *   independently assembled organisms, and two of them agree about a contig name
 *   by coincidence (§8.5's argument, applied to a whole matrix rather than to a
 *   track).
 * - **A different bin size.** The two triangles would be drawn at two
 *   resolutions in one grid, so a pixel would mean 1 kb on one side of the
 *   diagonal and 5 kb on the other.
 * - **Different chromosomes.** Every coordinate in the picture is an index into
 *   one list of sequences. Two lists means the lower triangle is a map of
 *   somewhere else, drawn under this one's labels.
 */
export function compareRefusal(
  primary: OpenResult,
  second: OpenResult,
  contigs: { primary: Array<[string, number]>; second: Array<[string, number]> },
): string | null {
  if (primary.hasGenomes || second.hasGenomes) {
    const which = primary.hasGenomes ? 'This file' : fileLabel(second.uri)
    return (
      `${which} has a genome layer, and a metacool is not compared this way. Its axis is ` +
      'contigs from thousands of independently assembled organisms, so two such files agree ' +
      'about a contig name by coincidence rather than by construction.'
    )
  }
  if (primary.binsize !== second.binsize) {
    return (
      `Bin sizes differ: ${fmt.int(primary.binsize ?? 0)} bp against ` +
      `${fmt.int(second.binsize ?? 0)} bp. One grid cannot be two resolutions — open the ` +
      'matching resolution of the second file, if it has one.'
    )
  }
  const mismatch = firstContigMismatch(contigs.primary, contigs.second)
  if (mismatch !== null) return mismatch
  return null
}

/**
 * The first way two chromosome lists disagree, phrased for a reader.
 *
 * **A different spelling is not a disagreement** (§5.9). The two lists are
 * compared position by position, and where the names differ they are put to
 * {@link NameIndex} before the refusal is written: `chr1` against `1`, `chrXII`
 * against `12` and `chrM` against `MT` are the same assembly written by two
 * tools, and refusing to blend them was refusing the commonest pair of files
 * anybody actually has.
 *
 * What is *not* relaxed is anything the spelling cannot explain. The lists must
 * still be in the same order, because every coordinate in the blended picture
 * is an index into one of them; and two sequences that match by name must
 * still be the same number of bases, because that is the check that catches
 * hg19 against hg38 — where `chr1` is `chr1` in both and is not the same
 * sequence in either.
 *
 * **The second list may run on past the first.** A `.hic` out of Juicer keeps
 * the mitochondrion, `M`, after `Y`, where a 4DN cooler of the same assembly
 * stops at `chrY`. Every bin the picture reads is the first file's, and while
 * the second's list opens with the whole of the first's, each of those bins is
 * the same locus in both — the global index is the same running sum up to
 * there. What follows in the second file is never asked for, as a sequence the
 * first does not have could not be. The other way round is still refused: the
 * first file's last sequences would have a lower triangle with nothing to read.
 */
function firstContigMismatch(
  a: Array<[string, number]>,
  b: Array<[string, number]>,
): string | null {
  if (a.length > b.length) {
    return (
      `Chromosome counts differ: ${fmt.int(a.length)} against ${fmt.int(b.length)}. Every ` +
      'coordinate in the picture is an index into one list of sequences, so the second file has ' +
      'to carry every sequence of the first, in the same order. It may carry more after them: ' +
      'opened the other way round, this pair is drawn.'
    )
  }
  const named = ([name, length]: [string, number]): NamedSequence => ({ name, length })
  // Built once and only where a name actually differs, which for two files out
  // of one pipeline is never.
  let alignment: Alignment | null = null
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0]) {
      alignment ??= alignNames(a.map(named), b.map(named))
      const match = alignment.pairs.get(a[i][0])
      if (match?.name === b[i][0]) {
        // One sequence, two conventions, at the same position in both lists.
        // The length check below still has to pass.
      } else {
        return (
          `Chromosome ${fmt.int(i + 1)} is “${a[i][0]}” in this file and “${b[i][0]}” in the ` +
          'other, and they are not two spellings of one name. The two lists have to match, in ' +
          'order — a renamed or reordered assembly would draw one file’s chromosome under ' +
          'another’s label.'
        )
      }
    }
    if (a[i][1] !== b[i][1]) {
      const same = a[i][0] === b[i][0]
      return (
        `“${a[i][0]}” is ${fmt.int(a[i][1])} bp in this file and ` +
        `${same ? '' : `“${b[i][0]}” is `}${fmt.int(b[i][1])} bp in the other. ` +
        `${same ? 'Same name' : 'One sequence by name'}, different sequence: the bins would ` +
        'not line up.'
      )
    }
  }
  return null
}
