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
 * the strip cannot drift from the sessions it describes.
 */

import { button, el } from '../ui/dom'
import { KEYS, withKey } from '../ui/commands'
import { icon } from '../ui/icons'

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

  constructor(private readonly props: TabStripProps) {
    this.add = button('', () => this.props.onNew(), {
      class: 'btn btn-icon tab-new',
      title: withKey('New session — another file, with its own tracks and settings', KEYS.newSession),
    })
    this.add.replaceChildren(icon('plus', { size: 15 }))
    this.el = el('div', { class: 'tabstrip' }, this.list, this.add)
  }

  render(tabs: readonly TabSpec[], canAdd: boolean): void {
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
      attrs: { role: 'tab', 'aria-selected': String(tab.active) },
    })

    const label = el('button', {
      class: 'tab-label',
      type: 'button',
      text: tab.label,
      title: tab.nameable ? `${tab.hint}\n\nDouble-click to rename this session.` : tab.hint,
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
          ? 'Empty this session. The last tab is not closed — there would be nothing to drop a file on'
          : 'Close this session, and put its worker down',
    })
    close.replaceChildren(icon('x', { size: 13 }))

    node.append(label, close)
    this.rows.set(tab.id, { node, label, tab, index })
    return node
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
        'aria-label': 'Session name',
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
