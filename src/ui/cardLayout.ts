/**
 * Cards a reader has moved: by their heading, within a column and across them.
 *
 * **Every column rebuilds its cards on its own schedule**, and that is what
 * shapes this module. The Aesthetics column is a new set of cards on every
 * navigation, the Annotations column is re-listed from the session's own array
 * each time a view mounts, the General column refills its record host on every
 * render, and a tab switch replaces all four. None of them knows about the
 * others, and none of them should have to know that a reader moved the Export
 * card above the Tracks one. So the arrangement is not an instruction handed to
 * each builder: it is *put back* after whatever they did, by one pass that reads
 * the columns as they now stand and moves the cards the reader moved.
 *
 * **A card's name is where it was built and what it is called**: `aesthetics/
 * Export`, `annotations/Tracks`. The heading because it is what the reader
 * dragged by and what stays the same when the card is rebuilt; the column it
 * was built in because two columns each have a *Tracks* card, and they are not
 * the same card.
 *
 * **A moved card leaves a comment where it stood.** Its builder can go on
 * treating that spot as the card's — replacing the host's children, re-listing
 * them — and the pass reads what the builder did from the comment: still there,
 * the card is still wanted and goes where the reader put it; gone, the builder
 * rebuilt without it, and the copy the reader moved goes too. A comment because
 * it is not an element: no selector counts it, `:empty` ignores it, and a host
 * that is replaced takes it away with everything else.
 *
 * **An arranged column holds its cards in its zone** (`SidePanel.zone`), in the
 * reader's order, with the host's wrappers laid out as though they were not
 * there (`.is-arranged` in the stylesheet). A column nobody has rearranged is
 * left exactly as its builder made it, so a reader who never drags a card sees
 * the app they always saw.
 *
 * Remembered per browser (`localStorage`), like a column's width: where somebody
 * keeps their cards is a preference about them, not about a file (§5.6).
 */

/** One side column, as the arranger sees it. */
export interface ArrangedColumn {
  /** `general`, `annotations`, … — what a card's name starts with. */
  readonly id: string
  readonly bodyEl: HTMLElement
  readonly zone: HTMLElement
  /** Open and on screen: a drag can drop a card here. */
  readonly isOpen: boolean
}

/** The stored arrangement: each rearranged column's cards, by name, in order. */
export type CardOrder = Record<string, string[]>

const KEY = 'chromosomix:card-layout'

/** The comment a moved card leaves at home, and the card it stands for. */
const cardOfAnchor = new WeakMap<Comment, HTMLElement>()
/** …and the other way. */
const anchorOfCard = new WeakMap<HTMLElement, Comment>()

/** Where a card's builder put it: its comment where it has been moved, else itself. */
function homeNode(card: HTMLElement): Node {
  const anchor = anchorOfCard.get(card)
  return anchor !== undefined && anchor.isConnected ? anchor : card
}

/**
 * The element a card's builder put it in, wherever the reader has moved it.
 *
 * What a builder that asks "is my card still in my aside" must ask, rather than
 * `parentElement`: an arranged card's parent is its column's zone.
 */
export function homeParent(card: HTMLElement): ParentNode | null {
  return homeNode(card).parentNode
}

/**
 * Put `next` where `card` is, and take `card` out — at home and on screen both.
 *
 * `replaceWith` for a card that may have been moved: the one that comes in
 * stands in the other's place in the reader's arrangement, and its home spot is
 * the other's too, so the pass that follows finds nothing to correct.
 */
export function swapCard(card: HTMLElement, next: HTMLElement): void {
  const anchor = anchorOfCard.get(card)
  if (anchor !== undefined && anchor.isConnected) {
    anchorOfCard.delete(card)
    cardOfAnchor.set(anchor, next)
    anchorOfCard.set(next, anchor)
  }
  if (card.parentNode !== null) card.replaceWith(next)
}

/** Insert `next` right after `card`'s home spot — the builder's "after this card". */
export function afterHome(card: HTMLElement, next: HTMLElement): void {
  const home = homeNode(card)
  const parent = home.parentNode
  if (parent !== null) parent.insertBefore(next, home.nextSibling)
}

/** Take a card out for good: from the reader's arrangement and from its home. */
export function removeCard(card: HTMLElement): void {
  const anchor = anchorOfCard.get(card)
  if (anchor !== undefined) {
    anchor.remove()
    anchorOfCard.delete(card)
  }
  card.remove()
}

/**
 * Whether a host holds a card — where it is, or where it has been moved from.
 *
 * `host.contains(card)` for a builder whose card the reader may have carried to
 * another column.
 */
export function hostHolds(host: Node, card: HTMLElement): boolean {
  return host.contains(card) || host.contains(anchorOfCard.get(card) ?? null)
}

/** A card this module can move: a `.card` or `.controls-card` with a heading. */
export function isArrangeable(node: Element): node is HTMLElement {
  return (
    node instanceof HTMLElement &&
    (node.classList.contains('card') || node.classList.contains('controls-card')) &&
    headOf(node) !== null
  )
}

/** A card's heading: the strip that folds it, and the one it is dragged by. */
export function headOf(card: HTMLElement): HTMLElement | null {
  for (const child of card.children) {
    if (child instanceof HTMLElement && child.classList.contains('card-head')) return child
  }
  return null
}

/** The words of a card's heading, which is what its name is made of. */
function titleOf(card: HTMLElement): string {
  return (headOf(card)?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

/** A card found in the columns, and what the pass knows about it. */
interface Found {
  readonly card: HTMLElement
  readonly name: string
  /** The column it was built in. */
  readonly home: string
  /** Its comment where it has been moved out of its home, else `null`. */
  readonly anchor: Comment | null
}

export interface CardArrangerOptions {
  /** The five columns, in the order the stored arrangement is read. */
  columns(): readonly ArrangedColumn[]
  /**
   * Whether this window's arrangement is the reader's: `false` in an embed,
   * whose columns neither read nor write one, for `SidePanel`'s reason.
   */
  remembers: boolean
  /** Called after a pass that changed which columns hold cards of their own. */
  onChange?(): void
}

/**
 * The arrangement, kept: read, put back after every rebuild, and changed by a
 * drag.
 */
export class CardArranger {
  private order: CardOrder
  private readonly observer: MutationObserver | null
  private scheduled = false
  /** Set while a drag is carrying a card: the pass waits for the drop. */
  private holding = false
  private drag: CardDrag | null = null

  constructor(private readonly options: CardArrangerOptions) {
    this.order = options.remembers ? readOrder() : {}
    this.observer =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            if (records.some(touchesCards)) this.schedule()
          })
    for (const column of options.columns()) {
      this.observer?.observe(column.bodyEl, { childList: true, subtree: true })
      column.bodyEl.addEventListener('pointerdown', (event) => this.pointerDown(column, event))
      column.bodyEl.addEventListener('keydown', (event) => this.keyDown(column, event))
    }
    this.arrange()
  }

  /** Whether any column has been rearranged — what a reset has to undo. */
  get arranged(): boolean {
    return Object.keys(this.order).length > 0
  }

  /** A copy of the stored arrangement, for the tests and a saved workspace. */
  get layout(): CardOrder {
    return Object.fromEntries(Object.entries(this.order).map(([id, names]) => [id, [...names]]))
  }

  /** Whether a column shows cards the reader carried into it from elsewhere. */
  holdsForeign(id: string): boolean {
    const column = this.options.columns().find((each) => each.id === id)
    if (column === undefined) return false
    for (const child of column.zone.children) {
      if (!(child instanceof HTMLElement)) continue
      const anchor = anchorOfCard.get(child)
      if (anchor !== undefined && !column.bodyEl.contains(anchor)) return true
    }
    return false
  }

  /** Every card back in the column it was built in, in its builder's order. */
  reset(): void {
    this.order = {}
    this.save()
    this.arrange()
  }

  /**
   * Move a card to `index` among the cards of column `to` — what a drop does.
   *
   * The column's whole order is recorded, not only the card that moved: a
   * column the reader has touched is theirs, and a card that appears in it later
   * goes after the one it followed at home rather than wherever its builder put
   * it relative to cards that are no longer there.
   */
  place(card: HTMLElement, to: string, index: number): void {
    const found = this.find().get(card)
    if (found === undefined) return
    const names = this.shownIn(to).filter((name) => name !== found.name)
    names.splice(Math.max(0, Math.min(index, names.length)), 0, found.name)
    for (const [id, listed] of Object.entries(this.order)) {
      if (id !== to) this.order[id] = listed.filter((name) => name !== found.name)
    }
    this.order[to] = names
    this.save()
    this.arrange()
  }

  /** Put the arrangement back: after a rebuild, a drop, a reset. */
  arrange(): void {
    if (this.holding) return
    const columns = this.options.columns()
    const found = this.find()
    const byName = new Map<string, Found>()
    for (const each of found.values()) if (!byName.has(each.name)) byName.set(each.name, each)
    const foreignBefore = new Set(columns.filter((column) => this.holdsForeign(column.id)).map((column) => column.id))

    // A card that appeared in a rearranged column since the order was taken
    // goes after the card it follows at home, so a column that gains a card
    // gains it where its builder meant it to be.
    let learned = false
    for (const column of columns) {
      const listed = this.order[column.id]
      if (listed === undefined) continue
      let after = -1
      for (const each of found.values()) {
        if (each.home !== column.id) continue
        const at = this.indexAnywhere(each.name)
        if (at !== null) {
          if (at.column === column.id) after = at.index
          continue
        }
        listed.splice(after + 1, 0, each.name)
        after += 1
        learned = true
      }
    }
    if (learned) this.save()

    // Where each card goes: the column that lists it, or home.
    for (const each of byName.values()) {
      const at = this.indexAnywhere(each.name)
      if (at === null && each.anchor !== null) {
        // Unlisted, and away from home: back where its builder put it.
        each.anchor.replaceWith(each.card)
        anchorOfCard.delete(each.card)
      }
    }
    for (const column of columns) {
      const listed = this.order[column.id]
      column.bodyEl.classList.toggle('is-arranged', listed !== undefined)
      if (listed === undefined) continue
      let slot = 0
      for (const name of listed) {
        const each = byName.get(name)
        if (each === undefined) continue
        if (each.anchor === null) {
          // Leaving home for the first time: a comment keeps its place.
          const anchor = document.createComment(`card: ${each.name}`)
          each.card.before(anchor)
          cardOfAnchor.set(anchor, each.card)
          anchorOfCard.set(each.card, anchor)
        }
        const there = column.zone.children[slot]
        if (there !== each.card) column.zone.insertBefore(each.card, there ?? null)
        slot += 1
      }
    }
    // Whatever is left in a zone is a copy nobody wants any more: a card whose
    // builder rebuilt without it, or another tab's, whose own zone this is not.
    const wanted = new Set([...byName.values()].map((each) => each.card))
    for (const column of columns) {
      for (const child of [...column.zone.children]) {
        if (!(child instanceof HTMLElement) || !wanted.has(child)) child.remove()
      }
    }
    this.observer?.takeRecords()
    const foreignAfter = columns.filter((column) => this.holdsForeign(column.id)).map((column) => column.id)
    if (foreignAfter.length !== foreignBefore.size || foreignAfter.some((id) => !foreignBefore.has(id))) {
      this.options.onChange?.()
    }
  }

  /** Where a card is listed, if a rearranged column lists it. */
  private indexAnywhere(name: string): { column: string; index: number } | null {
    for (const [column, names] of Object.entries(this.order)) {
      const index = names.indexOf(name)
      if (index >= 0) return { column, index }
    }
    return null
  }

  /** The names of the cards a column shows now, top to bottom. */
  private shownIn(id: string): string[] {
    const column = this.options.columns().find((each) => each.id === id)
    if (column === undefined) return []
    const found = this.find()
    const out: string[] = []
    for (const card of cardsIn(column.bodyEl)) {
      const each = found.get(card)
      if (each !== undefined && !out.includes(each.name)) out.push(each.name)
    }
    return out
  }

  /**
   * Every card in every column, with its name and its home.
   *
   * Cards at home are read where they stand; cards that have been moved are
   * read from their comments, which is what tells a card still wanted from one
   * whose builder has since let it go. A card whose comment is in a host that
   * is not on the page — another tab's — is not found at all, and so is not
   * shown in this one.
   */
  private find(): Map<HTMLElement, Found> {
    // Gathered first and settled after, because the two kinds can meet under
    // one name: a card its builder has just rebuilt, at home, and the copy the
    // reader moved, still held by its comment. The new one wins wherever the
    // two stand in the page, and the old one and its comment go. Kept in the
    // order the columns hold them, which is what "the card it follows at
    // home" is read from.
    const seq: Found[] = []
    const fresh = new Set<string>()
    for (const column of this.options.columns()) {
      const walker = document.createTreeWalker(column.bodyEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT, {
        acceptNode: (node) => {
          if (node === column.zone) return NodeFilter.FILTER_REJECT
          if (node instanceof Comment) return cardOfAnchor.has(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
          if (node instanceof Element && (node.classList.contains('card') || node.classList.contains('controls-card'))) {
            // A card's inside is its own; nothing in it is a card of the column.
            return isArrangeable(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
          }
          return NodeFilter.FILTER_SKIP
        },
      })
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        if (node instanceof Comment) {
          const card = cardOfAnchor.get(node)
          if (card === undefined || anchorOfCard.get(card) !== node) {
            node.remove()
            continue
          }
          // Borrowed — the enlarged structure dialog has its card — and given
          // back where it was taken from: not this pass's to move.
          if (card.isConnected && !this.inAnyColumn(card)) continue
          seq.push({ card, name: nameOf(card, column.id), home: column.id, anchor: node })
          continue
        }
        const card = node as HTMLElement
        const name = nameOf(card, column.id)
        if (fresh.has(name)) continue
        fresh.add(name)
        seq.push({ card, name, home: column.id, anchor: null })
      }
    }
    const out = new Map<HTMLElement, Found>()
    const taken = new Set<string>()
    for (const each of seq) {
      if (each.anchor !== null && fresh.has(each.name)) {
        each.anchor.remove()
        anchorOfCard.delete(each.card)
        continue
      }
      if (taken.has(each.name)) continue
      taken.add(each.name)
      out.set(each.card, each)
    }
    return out
  }

  private inAnyColumn(node: Node): boolean {
    return this.options.columns().some((column) => column.bodyEl.contains(node))
  }

  private schedule(): void {
    if (this.scheduled || this.holding) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.arrange()
    })
  }

  private save(): void {
    if (!this.options.remembers) return
    try {
      if (Object.keys(this.order).length === 0) window.localStorage.removeItem(KEY)
      else window.localStorage.setItem(KEY, JSON.stringify({ v: 1, columns: this.order }))
    } catch {
      /* a browser that refuses storage keeps the arrangement for this page */
    }
  }

  // -------------------------------------------------------------------------
  // The drag
  // -------------------------------------------------------------------------

  private pointerDown(column: ArrangedColumn, event: PointerEvent): void {
    if (event.button !== 0 || this.drag !== null) return
    const target = event.target
    if (!(target instanceof Element)) return
    // The heading's own controls — the fold chevron, a file's close button —
    // are pressed, not dragged.
    if (target.closest('button, input, select, textarea, a, label, [contenteditable="true"]') !== null) return
    const head = target.closest('.card-head')
    const card = head?.parentElement
    if (head === null || card === null || card === undefined || !isArrangeable(card)) return
    if (!column.bodyEl.contains(card) || headOf(card) !== head) return
    this.drag = new CardDrag(this, card, event, () => {
      this.drag = null
    })
  }

  /** ⌥↑ / ⌥↓ on a card's heading moves it one place up or down its column. */
  private keyDown(column: ArrangedColumn, event: KeyboardEvent): void {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    const target = event.target
    if (!(target instanceof Element)) return
    const head = target.closest('.card-head')
    const card = head?.parentElement
    if (head === null || card === null || card === undefined || !isArrangeable(card)) return
    const cards = cardsIn(column.bodyEl)
    const at = cards.indexOf(card)
    if (at < 0) return
    event.preventDefault()
    const to = at + (event.key === 'ArrowUp' ? -1 : 1)
    if (to < 0 || to >= cards.length) return
    this.place(card, column.id, to)
    // The focus stays on what was pressed, which moved with its card.
    if (target instanceof HTMLElement) target.focus()
  }

  /** @internal The drag's view of the columns. */
  openColumns(): readonly ArrangedColumn[] {
    return this.options.columns().filter((column) => column.isOpen)
  }

  /** @internal Hold the pass while a card is in the air, and run it on landing. */
  hold(holding: boolean): void {
    this.holding = holding
    if (!holding) this.observer?.takeRecords()
  }
}

/**
 * The name a card is arranged by: its home column and its heading.
 *
 * Read afresh each time rather than stamped on the card, so a column nobody has
 * rearranged is not so much as touched.
 */
function nameOf(card: HTMLElement, home: string): string {
  return `${home}/${titleOf(card)}`
}

/** The arrangeable cards under a column's body, top to bottom, zone included. */
export function cardsIn(body: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = []
  const walk = (node: Element): void => {
    for (const child of node.children) {
      if (child.classList.contains('card') || child.classList.contains('controls-card')) {
        if (isArrangeable(child)) out.push(child)
        continue
      }
      if (child.classList.contains('card-drop')) continue
      walk(child)
    }
  }
  walk(body)
  return out
}

/**
 * Whether a mutation could have moved a card, rather than changed one.
 *
 * Every card rewrites its own insides constantly — a track's row, a task's
 * status — and none of that is the arranger's business. What is, is a host, a
 * wrapper or a zone gaining or losing children.
 */
function touchesCards(record: MutationRecord): boolean {
  if (record.type !== 'childList') return false
  const target = record.target
  if (!(target instanceof Element)) return false
  return target.closest('.card, .controls-card') === null
}

function readOrder(): CardOrder {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const columns = (parsed as { columns?: unknown }).columns
    if (typeof columns !== 'object' || columns === null) return {}
    const out: CardOrder = {}
    for (const [id, names] of Object.entries(columns as Record<string, unknown>)) {
      if (!Array.isArray(names)) continue
      out[id] = names.filter((name): name is string => typeof name === 'string')
    }
    return out
  } catch {
    return {}
  }
}

/** How far the pointer travels before a press on a heading becomes a drag. */
const DRAG_START = 5
/** How near a column's top or bottom edge the pointer scrolls it. */
const SCROLL_EDGE = 36

/**
 * One card being carried by its heading.
 *
 * The card itself is lifted — fixed to the pointer, where it keeps its width
 * and everything drawn in it — and a dashed slot of its height marks where it
 * will land, moved between the cards of whichever open column is under the
 * pointer. Nothing is recorded until the drop, and Escape puts it back.
 */
class CardDrag {
  private started = false
  private readonly slot: HTMLElement
  private offset = { x: 0, y: 0 }
  private column: ArrangedColumn | null = null
  private scrollTimer = 0
  private lastY = 0

  constructor(
    private readonly arranger: CardArranger,
    private readonly card: HTMLElement,
    private readonly start: PointerEvent,
    private readonly done: () => void,
  ) {
    this.slot = document.createElement('div')
    this.slot.className = 'card-drop'
    window.addEventListener('pointermove', this.move)
    window.addEventListener('pointerup', this.up)
    window.addEventListener('pointercancel', this.cancel)
    window.addEventListener('keydown', this.key, true)
  }

  private readonly move = (event: PointerEvent): void => {
    if (event.pointerId !== this.start.pointerId) return
    if (!this.started) {
      if (Math.hypot(event.clientX - this.start.clientX, event.clientY - this.start.clientY) < DRAG_START) return
      this.lift()
    }
    event.preventDefault()
    this.card.style.left = `${event.clientX - this.offset.x}px`
    this.card.style.top = `${event.clientY - this.offset.y}px`
    this.lastY = event.clientY
    this.aim(event.clientX, event.clientY)
  }

  private lift(): void {
    this.started = true
    this.arranger.hold(true)
    const box = this.card.getBoundingClientRect()
    this.offset = { x: this.start.clientX - box.left, y: this.start.clientY - box.top }
    this.slot.style.height = `${box.height}px`
    this.card.before(this.slot)
    this.card.classList.add('is-lifted')
    this.card.style.width = `${box.width}px`
    this.card.style.left = `${box.left}px`
    this.card.style.top = `${box.top}px`
    document.body.classList.add('is-carrying-card')
    this.column = this.arranger.openColumns().find((column) => column.bodyEl.contains(this.slot)) ?? null
  }

  /** Move the slot to where the card would land under the pointer. */
  private aim(x: number, y: number): void {
    const column =
      this.arranger.openColumns().find((each) => {
        const box = each.bodyEl.getBoundingClientRect()
        return x >= box.left && x <= box.right && y >= box.top - SCROLL_EDGE && y <= box.bottom + SCROLL_EDGE
      }) ?? null
    if (column === null) return
    this.column = column
    const cards = cardsIn(column.bodyEl).filter((each) => each !== this.card && each.offsetHeight > 0)
    const before = cards.find((each) => {
      const box = each.getBoundingClientRect()
      return y < box.top + box.height / 2
    })
    if (before !== undefined) {
      if (before.previousElementSibling !== this.slot) before.before(this.slot)
    } else {
      const last = cards.at(-1)
      if (last !== undefined) {
        if (last.nextElementSibling !== this.slot) last.after(this.slot)
      } else if (this.slot.parentElement !== column.zone) {
        column.zone.append(this.slot)
      }
    }
    this.autoScroll()
  }

  /** Scroll the column under the pointer while it is held near an edge. */
  private autoScroll(): void {
    window.clearTimeout(this.scrollTimer)
    const body = this.column?.bodyEl
    if (body === undefined) return
    const box = body.getBoundingClientRect()
    const step = this.lastY < box.top + SCROLL_EDGE ? -12 : this.lastY > box.bottom - SCROLL_EDGE ? 12 : 0
    if (step === 0) return
    body.scrollTop += step
    this.scrollTimer = window.setTimeout(() => this.autoScroll(), 30)
  }

  private readonly up = (event: PointerEvent): void => {
    if (event.pointerId !== this.start.pointerId) return
    if (!this.started) {
      this.finish()
      return
    }
    // The click that ends a drag is not a press on the heading: without this
    // the card would fold the moment it landed.
    const swallow = (click: Event): void => {
      click.stopPropagation()
      click.preventDefault()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    const column = this.column
    // Where it lands: after however many of that column's cards are above the
    // slot, which is the one thing the slot is there to say.
    let at = 0
    if (column !== null) {
      for (const each of cardsIn(column.bodyEl)) {
        if (each === this.card) continue
        if (this.slot.compareDocumentPosition(each) & Node.DOCUMENT_POSITION_PRECEDING) at += 1
      }
    }
    this.drop()
    if (column !== null) this.arranger.place(this.card, column.id, at)
    else this.arranger.arrange()
  }

  private readonly cancel = (): void => {
    if (this.started) this.drop()
    else this.finish()
    this.arranger.arrange()
  }

  private readonly key = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.started) return
    event.preventDefault()
    event.stopPropagation()
    this.cancel()
  }

  /** The card back on the page where it was, the slot gone: ready to be placed. */
  private drop(): void {
    window.clearTimeout(this.scrollTimer)
    this.slot.remove()
    this.card.classList.remove('is-lifted')
    this.card.style.removeProperty('width')
    this.card.style.removeProperty('left')
    this.card.style.removeProperty('top')
    document.body.classList.remove('is-carrying-card')
    this.arranger.hold(false)
    this.finish()
  }

  private finish(): void {
    window.removeEventListener('pointermove', this.move)
    window.removeEventListener('pointerup', this.up)
    window.removeEventListener('pointercancel', this.cancel)
    window.removeEventListener('keydown', this.key, true)
    this.done()
  }
}
