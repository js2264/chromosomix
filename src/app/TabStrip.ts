/**
 * The row of tabs under the header.
 *
 * A tab is a *session*: its own file, its own tracks, its own colour scale, its
 * own worker. That is a stronger claim than a browser tab makes about a page,
 * and the strip is written to keep it visible — the label is the file, the
 * tooltip says what state it is in, and a tab that has been remembered but not
 * yet opened says so rather than pretending to hold a file it has not read.
 *
 * Rendered from a list on every change rather than patched in place. Twelve
 * buttons is not a number worth reconciling, and rebuilding is what guarantees
 * the strip cannot drift from the sessions it describes. The one exception is a
 * tab being carried along the strip ({@link TabDrag}), which holds the rebuilds
 * back until it is let go.
 */

import { button, el } from '../ui/dom'
import { KEYS, withKey } from '../ui/commands'
import { icon } from '../ui/icons'
import { tabStep } from '../ui/tabWalk'

export interface TabSpec {
  id: string
  label: string
  /** One line for the tooltip: the full URI, or why this tab is still empty. */
  hint: string
  /**
   * Whether this tab can be called something.
   *
   * A tab with nothing open cannot: the name is kept against the file
   * (`Session.rename`), so one given to an empty tab would be written under a
   * key nothing reads and would look as though it had been forgotten. The strip
   * therefore does not offer the gesture rather than accepting it and losing it.
   */
  nameable: boolean
  /** `true` when the label is the reader's own word rather than the file's. */
  named: boolean
  active: boolean
  /**
   * Remembered from a previous visit and not yet opened.
   *
   * Shown differently because it is a genuinely different thing: the file is
   * named but no byte of it has been read, and clicking is what reads it.
   */
  pending: boolean
}

export interface TabStripProps {
  onSelect(index: number): void
  onClose(index: number): void
  onNew(): void
  /**
   * Call this tab something, or — for an empty name — hand it back to its file.
   *
   * The empty string is a real answer rather than a cancelled edit, and the two
   * are distinguished by *how the box was left*: Enter commits whatever is in
   * it, Escape reports nothing at all. Without that, clearing the box would be
   * indistinguishable from changing one's mind, and there would be no gesture
   * for undoing a rename.
   */
  onRename(index: number, name: string): void
  /**
   * Take the tab at `from` and stand it at `to`, the index it holds once the
   * others have closed up behind it — what letting go of a carried tab asks.
   * Never called with the two equal: a tab let go where it was picked up has
   * not moved.
   */
  onMove(from: number, to: number): void
}

/**
 * How long after a click a second one on the same tab still means *rename*.
 *
 * Generous — the platform default is nearer 400 ms and some readers set it
 * higher — because the cost of the two ends is asymmetric. Too short and the
 * gesture silently does nothing, which reads as the feature not existing; too
 * long and an unlucky pair of deliberate clicks opens a box, which is one
 * Escape.
 */
const DOUBLE_CLICK_MS = 500

/**
 * How far the pointer travels before a press on a tab becomes a carry.
 *
 * The card headings' own (`ui/cardLayout.ts`), for the same reason: a press
 * that wobbles is a click, and a click on a tab is the commonest thing done to
 * one.
 */
const DRAG_START = 5
/** How near the strip's either end the pointer scrolls it, while a tab is carried. */
const SCROLL_EDGE = 32

export class TabStrip {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'tabs', attrs: { role: 'tablist' } })
  private readonly add: HTMLButtonElement
  /**
   * The nodes of the strip as it stands, by session id.
   *
   * The one piece of state a strip that rebuilds itself keeps, and it is kept
   * for exactly one caller: {@link beginRename}, which arrives from the command
   * palette holding an id and no DOM. Rebuilt with the strip, so it cannot name
   * a node that is no longer in it.
   */
  private readonly rows = new Map<
    string,
    { node: HTMLElement; label: HTMLElement; tab: TabSpec; index: number }
  >()
  /**
   * The rename in progress, if there is one, and how to abandon it.
   *
   * A strip that rebuilds itself on every change is the right design and it is
   * murder on an inline editor: `sessionChanged` fires when a track finishes
   * loading, when a companion's clip moves, when a read settles — none of which
   * is the reader, all of which arrive while they are typing a name. Without
   * this, a background read three seconds into a rename replaced the box with a
   * button and the half-typed name was gone.
   *
   * So the edit is *state*, not DOM: what is being typed survives the rebuild,
   * and {@link render} opens the box again on the new node with the text in it.
   * `abandon` is how the outgoing box is silenced — it is about to be removed
   * from the document, and a `blur` that fired as it went would commit a name
   * the reader had not finished.
   */
  private editing: { id: string; value: string; abandon: () => void } | null = null
  /** The last tab clicked and when, so a double click can be recognised. */
  private lastClick: { id: string; at: number } | null = null
  /** The press that may become a carry, and is one once it has travelled. */
  private drag: TabDrag | null = null
  /**
   * What the strip was last asked to show — the list a carry puts back on
   * Escape, and the one a rebuild held back during a carry is made from.
   */
  private shown: { tabs: readonly TabSpec[]; canAdd: boolean } = { tabs: [], canAdd: true }

  constructor(private readonly props: TabStripProps) {
    this.add = button('', () => this.props.onNew(), {
      class: 'btn btn-icon tab-new',
      title: withKey('New tab — another file, with its own tracks and settings', KEYS.newSession),
    })
    this.add.replaceChildren(icon('plus', { size: 15 }))
    this.el = el('div', { class: 'tabstrip' }, this.list, this.add)
    this.list.addEventListener('pointerdown', (event) => this.pointerDown(event))
  }

  render(tabs: readonly TabSpec[], canAdd: boolean): void {
    this.shown = { tabs, canAdd }
    // A tab in the hand is a node the reader is holding: a rebuild would take it
    // out of the document mid-carry. The list is kept and drawn on the drop.
    if (this.drag?.carrying === true) return
    // Taken *before* the rebuild and put back after it. See {@link editing}: the
    // outgoing box is silenced first, or its removal from the document would
    // read as the reader clicking away and commit a half-typed name.
    const held = this.editing
    held?.abandon()
    this.rows.clear()
    this.list.replaceChildren(
      ...tabs.map((tab, index) => this.tabNode(tab, index, tabs.length)),
    )
    // One session is not a tab bar, it is a title — so the strip stays, because
    // the way to a *second* session is the button on it, but it stops drawing a
    // box around the only thing there is.
    this.el.classList.toggle('single', tabs.length === 1)
    this.add.disabled = !canAdd
    // A tab that has *gone* — closed while its name was being typed — takes its
    // rename with it, which is the only honest answer: there is nothing left to
    // name.
    if (held !== null) this.beginRename(held.id, held.value)
  }

  private tabNode(tab: TabSpec, index: number, total: number): HTMLElement {
    const node = el('div', {
      class: `tab${tab.active ? ' is-active' : ''}${tab.pending ? ' is-pending' : ''}`,
      attrs: { role: 'tab', 'aria-selected': String(tab.active), 'data-tab': tab.id },
    })

    const label = el('button', {
      class: 'tab-label',
      type: 'button',
      text: tab.label,
      title: labelTitle(tab, total),
    })
    // Double-click, which is what every application with a nameable row uses and
    // what a reader will try first. It is *also* two selects, which is harmless:
    // the first click activates the tab, and renaming the tab you are looking at
    // is the case.
    //
    // **Counted here rather than left to the browser**, and that is not a
    // stylistic choice. Selecting a tab repaints the strip, which replaces this
    // very button between the two clicks — and both `dblclick` and a
    // `MouseEvent`'s own click count are computed against the element the clicks
    // landed on. So on any tab that was not already in front the gesture simply
    // never fired, which is the one tab a reader most needs to rename. A tab id
    // and a timestamp survive the rebuild; nothing about the DOM does.
    label.addEventListener('click', () => {
      // A label the strip has since rebuilt away speaks for a list that is no
      // longer on screen — the one a carried tab was dropped out of, where a
      // browser hands the click that ends the carry to the button it began on.
      if (!label.isConnected) return
      this.props.onSelect(index)
      if (!tab.nameable) return
      const at = Date.now()
      const again =
        this.lastClick !== null &&
        this.lastClick.id === tab.id &&
        at - this.lastClick.at <= DOUBLE_CLICK_MS
      // Cleared on the second, so a triple click is a rename and not a rename
      // followed by another one.
      this.lastClick = again ? null : { id: tab.id, at }
      if (again) this.beginRename(tab.id)
    })
    // Middle-click closes, which is what a tab strip does everywhere else and
    // costs nothing to honour. `auxclick` rather than `mousedown`, so a
    // middle-press that drifts off the tab does not close it.
    node.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return
      event.preventDefault()
      this.props.onClose(index)
    })

    const close = button('', () => this.props.onClose(index), {
      class: 'btn btn-icon tab-close',
      title:
        total === 1
          ? 'Empty this tab. The last one is not closed — there would be nothing to drop a file on'
          : 'Close this tab, and put its worker down',
    })
    close.replaceChildren(icon('x', { size: 13 }))

    node.append(label, close)
    this.rows.set(tab.id, { node, label, tab, index })
    return node
  }

  /**
   * A press on a tab, which is a click until the pointer travels.
   *
   * Pointer events rather than the browser's drag and drop, which this strip
   * cannot use: a tab is mostly its label, the label is a `<button>`, and
   * Firefox will not start a drag from a button. A carried tab also has
   * nowhere to go but along this strip, so nothing is lost by it — no other
   * target in the app takes a tab.
   *
   * Not from the ×, which is a button of its own, nor from a rename's box,
   * where a drag selects text; not with a finger, whose sideways swipe scrolls
   * a strip too long for the window and which the palette's *Move this tab*
   * serves instead; and not on a strip of one, which has nowhere to move it.
   */
  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || event.pointerType === 'touch' || this.drag !== null) return
    if (this.shown.tabs.length < 2) return
    const target = event.target
    if (!(target instanceof Element) || target.closest('.tab-close, .tab-rename') !== null) return
    const node = target.closest<HTMLElement>('.tab')
    const id = node?.dataset['tab']
    if (id === undefined || !this.rows.has(id)) return
    this.drag = new TabDrag(this, id, event, () => {
      this.drag = null
    })
  }

  /** The strip's tabs as they stand in the document, left to right. */
  tabNodes(): HTMLElement[] {
    return [...this.list.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('tab'))
  }

  /** The scrolling row the tabs stand in. */
  get row(): HTMLElement {
    return this.list
  }

  /** The node a tab id is drawn as, now. */
  nodeOf(id: string): HTMLElement | undefined {
    return this.rows.get(id)?.node
  }

  /**
   * A carry has ended: draw the strip from its list again — which puts back the
   * order the carry was showing and anything a rebuild held back meanwhile —
   * and only then report the move, which repaints it once more in its new order.
   *
   * Where it landed is said as the tab it landed **after** (`null` for first),
   * not as an index, because the list may have changed while it was held — a
   * tab opened by a link, one closed by the palette — and a neighbour is still
   * a neighbour in that list where a position is not. `undefined` is no move.
   */
  settle(id: string, after: string | null | undefined): void {
    const tabs = this.shown.tabs
    this.render(tabs, this.shown.canAdd)
    if (after === undefined) return
    const from = tabs.findIndex((tab) => tab.id === id)
    const others = tabs.filter((tab) => tab.id !== id).map((tab) => tab.id)
    const to = after === null ? 0 : others.indexOf(after) + 1
    // A neighbour that has gone is a landing nobody can name.
    if (from < 0 || (after !== null && to === 0) || to === from) return
    this.props.onMove(from, to)
  }

  /**
   * Put the caret in the tab that is on screen — the palette's road in.
   *
   * By *id* rather than by index, because the caller that wants it is a command
   * and a command runs after a repaint may have moved things. A tab that is not
   * there, or not nameable, is silently nothing: the command is already gated on
   * a file being open, and a second refusal here would be a second message about
   * the same absence.
   */
  beginRename(id: string, text?: string): void {
    const found = this.rows.get(id)
    if (found === undefined || !found.tab.nameable) return
    this.edit(found, text)
  }

  /**
   * Swap the tab's button for a box, and put back whichever answer arrives.
   *
   * A box in place of the label rather than a dialog. Renaming a tab is a
   * two-second edit made while looking at the strip, and a modal for it would
   * take the window away from the thing being named — which is also the only
   * context that tells the reader *which* of six tabs they are about to rename.
   *
   * Three ways out and all three are answers: **Enter** commits what is in the
   * box, including nothing, which is how a name is taken back off. **Escape**
   * reports nothing at all, so a cleared box that changed its mind is not a
   * rename to blank. **Blur** commits too — clicking away from a box you have
   * typed into means what you typed everywhere else, and the alternative is a
   * reader who renames a tab, clicks the map, and finds the name gone.
   */
  private edit(
    row: { node: HTMLElement; label: HTMLElement; tab: TabSpec; index: number },
    text?: string,
  ): void {
    if (this.editing?.id === row.tab.id && row.node.contains(document.activeElement)) return
    const { label, tab, index } = row
    const input = el('input', {
      class: 'input input-tiny tab-rename',
      type: 'text',
      attrs: {
        // The file name as the *placeholder* rather than as the value, so the
        // box opens empty on an unnamed tab: a reader who types is naming it,
        // and one who presses Enter on the file's own name has said "call it
        // what it is called", which is no name at all.
        placeholder: tab.label,
        // The reader's word, which a screen reader speaks too (§5.6): *session*
        // is the code's, and the strip never shows it.
        'aria-label': 'Tab name',
        spellcheck: 'false',
      },
    })
    // A rename that survived a rebuild resumes with what was typed; a fresh one
    // opens on the name there is, and on nothing at all where the label is the
    // file's own.
    input.value = text ?? (tab.named ? tab.label : '')
    let done = false
    const finish = (commit: boolean): void => {
      if (done) return
      done = true
      this.editing = null
      input.replaceWith(label)
      if (commit) this.props.onRename(index, input.value)
    }
    this.editing = {
      id: tab.id,
      value: input.value,
      // Silence, not cancel: the box is about to be taken out of the document by
      // a rebuild, and its `blur` must not read as the reader clicking away.
      // Nothing is put back either — the rebuild replaces the whole strip.
      abandon: () => {
        done = true
        this.editing = null
      },
    }
    input.addEventListener('input', () => {
      if (this.editing !== null) this.editing.value = input.value
    })
    input.addEventListener('keydown', (event) => {
      const step = tabStep(event)
      if (step !== null) {
        // Enter that goes on to the next tab's name (§26.8), Shift+Tab to the
        // one before, past either end nowhere. Found by id after the commit,
        // which repaints the strip a renamed tab is in.
        event.preventDefault()
        const named = [...this.rows.values()].filter((each) => each.tab.nameable).map((each) => each.tab.id)
        const next = named[named.indexOf(tab.id) + step]
        finish(true)
        if (next !== undefined) this.beginRename(next)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
        return
      }
      if (event.key !== 'Escape') return
      // Stopped here, or the shell's own Escape would close the dialog behind
      // this or clear a selection — a key pressed in a text box belongs to the
      // box (`ui/commands.ts`'s `isTypingTarget` makes the same call).
      event.preventDefault()
      event.stopPropagation()
      finish(false)
    })
    input.addEventListener('blur', () => finish(true))
    label.replaceWith(input)
    input.focus()
    input.select()
  }
}

/**
 * The tooltip on a tab's label: where it points, then what can be done to it
 * that a click does not say — renamed, where it has a file to keep a name
 * against, and moved, where there is another tab to move it past.
 */
function labelTitle(tab: TabSpec, total: number): string {
  const verbs =
    tab.nameable && total > 1
      ? 'Double-click to rename this tab, or drag it along the strip to move it.'
      : tab.nameable
        ? 'Double-click to rename this tab.'
        : total > 1
          ? 'Drag it along the strip to move it.'
          : null
  return verbs === null ? tab.hint : `${tab.hint}\n\n${verbs}`
}

/**
 * One tab carried along the strip by its label (§5.6).
 *
 * The tab itself is what moves: it follows the pointer sideways, lifted over
 * its neighbours, and stands in the row wherever it would land — so the others
 * close up behind it and open a gap ahead of it as it goes, and the gap is the
 * answer to *where will it go*. It lands at the place among the others whose
 * middles are left of the pointer, which is the place the gap is in.
 *
 * Nothing is reported until the drop, and Escape puts the strip back as it
 * was. A tab carried is not selected: selecting a tab that was remembered and
 * not yet opened reads its file, and moving one is not asking for that.
 */
class TabDrag {
  /** Whether the press has travelled far enough to be a carry. */
  carrying = false
  /** Where in the tab the pointer took hold of it, from its left edge. */
  private grab = 0
  private scrollTimer = 0
  private lastX = 0

  constructor(
    private readonly strip: TabStrip,
    private readonly id: string,
    private readonly start: PointerEvent,
    private readonly done: () => void,
  ) {
    this.lastX = start.clientX
    window.addEventListener('pointermove', this.move)
    window.addEventListener('pointerup', this.up)
    window.addEventListener('pointercancel', this.cancel)
    window.addEventListener('keydown', this.key, true)
  }

  private readonly move = (event: PointerEvent): void => {
    if (event.pointerId !== this.start.pointerId) return
    if (!this.carrying) {
      if (Math.hypot(event.clientX - this.start.clientX, event.clientY - this.start.clientY) < DRAG_START) return
      if (!this.lift()) return
    }
    event.preventDefault()
    this.lastX = event.clientX
    this.aim()
    this.autoScroll()
  }

  /**
   * Take hold of the tab — found by its id, since a rename committed by this
   * very press may have rebuilt the strip under it — or give up on a tab that
   * is no longer there.
   */
  private lift(): boolean {
    const node = this.strip.nodeOf(this.id)
    if (node === undefined) {
      this.finish()
      return false
    }
    this.carrying = true
    this.grab = this.start.clientX - node.getBoundingClientRect().left
    node.classList.add('is-carried')
    this.strip.el.classList.add('is-carrying')
    document.body.classList.add('is-carrying-tab')
    return true
  }

  /** Stand the tab where it would land, and under the pointer. */
  private aim(): void {
    const node = this.strip.nodeOf(this.id)
    if (node === undefined) return
    const others = this.strip.tabNodes().filter((each) => each !== node)
    const to = others.filter((each) => {
      const box = each.getBoundingClientRect()
      return box.left + box.width / 2 < this.lastX
    }).length
    const before = others[to]
    if (before === undefined) {
      const last = others.at(-1)
      if (last !== undefined && last.nextElementSibling !== node) last.after(node)
    } else if (before.previousElementSibling !== node) {
      before.before(node)
    }
    // Where the row puts it, less whatever it is already shifted by, is where
    // it stands; the shift is whatever is left to the pointer — kept between
    // where the first tab and the last one stand, since the row clips what
    // crosses its ends and a tab's shoulders reach into its margins.
    node.style.transform = ''
    const rest = node.getBoundingClientRect()
    const row = this.strip.row.getBoundingClientRect()
    const inset =
      (parseFloat(getComputedStyle(this.strip.row).paddingLeft) || 0) + (parseFloat(getComputedStyle(node).marginLeft) || 0)
    const left = Math.max(row.left + inset, Math.min(this.lastX - this.grab, row.right - inset - rest.width))
    node.style.transform = `translateX(${left - rest.left}px)`
  }

  /** Scroll the strip while the tab is held near either end of it. */
  private autoScroll(): void {
    window.clearTimeout(this.scrollTimer)
    const row = this.strip.row
    if (row.scrollWidth <= row.clientWidth) return
    const box = row.getBoundingClientRect()
    const step = this.lastX < box.left + SCROLL_EDGE ? -12 : this.lastX > box.right - SCROLL_EDGE ? 12 : 0
    if (step === 0) return
    row.scrollLeft += step
    this.aim()
    this.scrollTimer = window.setTimeout(() => this.autoScroll(), 30)
  }

  private readonly up = (event: PointerEvent): void => {
    if (event.pointerId !== this.start.pointerId) return
    if (!this.carrying) {
      this.finish()
      return
    }
    // The click that ends a carry is not a press on the tab: without this the
    // tab would be selected — and, if it was only remembered, its file read —
    // the moment it landed, and the click would count towards a rename.
    const swallow = (click: Event): void => {
      click.stopPropagation()
      click.preventDefault()
    }
    window.addEventListener('click', swallow, { capture: true, once: true })
    window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
    const node = this.strip.nodeOf(this.id)
    const before = node?.previousElementSibling
    this.drop(node === undefined ? undefined : before instanceof HTMLElement ? (before.dataset['tab'] ?? null) : null)
  }

  private readonly cancel = (): void => {
    if (this.carrying) this.drop(undefined)
    else this.finish()
  }

  private readonly key = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.carrying) return
    // Stopped, as a rename's Escape is: the shell's own would clear a selection
    // or close a dialog behind the strip.
    event.preventDefault()
    event.stopPropagation()
    this.cancel()
  }

  /** Let go after the tab `after` names, first for `null`, or — for `undefined` — back where it was. */
  private drop(after: string | null | undefined): void {
    window.clearTimeout(this.scrollTimer)
    this.carrying = false
    this.strip.el.classList.remove('is-carrying')
    document.body.classList.remove('is-carrying-tab')
    this.finish()
    this.strip.settle(this.id, after)
  }

  private finish(): void {
    window.removeEventListener('pointermove', this.move)
    window.removeEventListener('pointerup', this.up)
    window.removeEventListener('pointercancel', this.cancel)
    window.removeEventListener('keydown', this.key, true)
    this.done()
  }
}
