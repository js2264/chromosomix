/**
 * A caret in a limit, exactly where the limit is drawn.
 *
 * The range under a track's name is the one thing on a lane a reader edits — it
 * is the axis every value in the picture is read against — and it should be
 * edited where it is read. An `<input>` is laid over the box the text was
 * measured into, so the number does not move when it becomes editable, which is
 * the whole claim being made by putting a text cursor over it.
 *
 * The commit rules are the point of this being a module rather than a method.
 * Each of them exists because of a way the obvious implementation is wrong, and
 * a second copy written beside a map would have had to rediscover all five:
 * opening a limit and not changing it is not a decision; an emptied box is that
 * said differently; an inverted pair is refused *in place* rather than swallowed
 * into a `[0, 1]` nobody asked for; the other end comes from the axis on screen
 * rather than from a store that may hold nothing; and Escape must not commit on
 * the way out, even though removing a focused node is a blur.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry } from '../annotations/types'
import type { LimitBox } from '../render/laneLabel'
import { el } from './dom'

/** One end of one lane's axis, ready to be typed into. */
export interface LimitTarget {
  /**
   * Every track the range belongs to — which for an overlay group is all of
   * them, not the one whose limits happened to be written down.
   *
   * A lane draws one range under however many names it holds, and that single
   * pair is a claim about the *lane*: the whole point of overlaying two tracks
   * is that they are drawn against one axis. Committing to only the first would
   * leave two lines at two scales in one lane with one label, which is the exact
   * picture a group exists to prevent.
   */
  entries: AnnotationEntry[]
  hit: LimitBox
}

export interface LaneLimitEditorOptions {
  /** Where the box is parented; must be positioned, and over the canvas. */
  host: HTMLElement
  store: AnnotationStore
  /**
   * The pair a track's axis is drawn with right now, group included.
   *
   * Resolved rather than stored: an autoscaled track has no *stored* pair to
   * amend, so the other end has to come from the axis on screen — which is the
   * one the reader was looking at when they typed. (The side panel's own boxes
   * seed from the file's whole-genome extent instead, because a panel is not a
   * view and must not show a number that changes when you pan.)
   */
  shownLimits(id: string): { min: number; max: number } | null
  /** Ask for a repaint — the canvas hides the number the box is standing on. */
  onChange(): void
}

export class LaneLimitEditor {
  private open_:
    | { input: HTMLInputElement; cancel: () => void; commit: () => void }
    | null = null

  constructor(private readonly options: LaneLimitEditorOptions) {}

  /** Whether a caret is in a limit right now. */
  get isOpen(): boolean {
    return this.open_ !== null
  }

  /**
   * Put a caret in a limit.
   *
   * `offset` converts the lane canvas's own pixels into the host's, exactly as
   * {@link LaneControls.sync} does — beside a map the stack is a grid item and
   * the layer is positioned against the grid, while in the browser the two share
   * an origin.
   */
  open(target: LimitTarget, offset: { left: number; top: number }): void {
    // The one that is already open is *finished*, not abandoned. The press that
    // lands on a second limit calls `preventDefault`, so it never produces the
    // focus change that would have committed the first — and cancelling here
    // would make the natural gesture for setting the same bound on two tracks in
    // a row the one gesture that silently throws the first number away. Clicking
    // anywhere *else* on the canvas already commits it; these two have to agree.
    this.open_?.commit()
    this.close()

    const { entries, hit } = target
    const [x, y, width] = hit.box
    const named = entries.map((entry) => entry.label).join(', ')
    const input = el('input', {
      class: 'input lane-edit',
      type: 'text',
      value: hit.value,
      title:
        `${hit.part === 'min' ? 'Bottom' : 'Top'} of ${named}’s value axis. ` +
        'Enter commits, Escape leaves it alone.',
    })
    input.style.left = `${Math.max(0, offset.left + x - 3)}px`
    input.style.top = `${offset.top + y - 2}px`
    input.style.width = `${Math.max(44, width + 22)}px`

    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      input.remove()
      if (this.open_?.input === input) this.open_ = null
      this.options.onChange()
    }
    /** Say no without closing, so the reader can correct what they typed. */
    const refuse = (): void => {
      input.classList.add('is-bad')
      window.setTimeout(() => input.classList.remove('is-bad'), 700)
      input.focus()
      input.select()
    }
    const commit = (typing: boolean): void => {
      // Escape closes by removing the node, and removing a focused node is a
      // blur — so without this guard the blur handler would commit the value the
      // reader had just cancelled, which is the opposite of what Escape is.
      if (closed) return
      const text = input.value.trim()
      // Opening a limit and not changing it is not a decision, and must not be
      // recorded as one. Without this, clicking a limit on an autoscaled track
      // and clicking away again takes it off autoscale for ever — at the
      // *rounded* number the label showed, which is not even the ceiling it had.
      // An emptied box is the same thing said differently: `input.select()` puts
      // the whole number under the first keystroke, so Backspace is how an edit
      // begun by accident is abandoned — and `Number('')` is `0`, which would
      // otherwise store a floor nobody typed.
      if (text === hit.value || text === '') {
        close()
        return
      }
      const typed = Number(text)
      const first = this.options.store.byId(entries[0]?.id ?? '')?.style.limits
      if (!Number.isFinite(typed) || first === undefined) {
        if (typing) refuse()
        else close()
        return
      }
      const shown = this.options.shownLimits(entries[0]?.id ?? '') ?? {
        min: first.min,
        max: first.max,
      }
      const next =
        hit.part === 'min' ? { min: typed, max: shown.max } : { min: shown.min, max: typed }
      // An inverted pair is refused rather than swallowed. `resolveLimits` would
      // answer it with `{0, 1}`, which is a lane redrawn against an axis nobody
      // asked for — and the reader would be left looking for the number they
      // typed. Refused *in place*, with the caret still in it.
      if (!(next.max > next.min)) {
        if (typing) refuse()
        else close()
        return
      }
      close()
      for (const entry of entries) {
        this.options.store.restyle(entry.id, { limits: { auto: false, ...next } })
      }
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    })
    // A blur is not a keystroke: whatever it carries is either good or gone.
    // Refusing in place would fight for a focus the reader has already moved on
    // from — and the box is closed by then anyway.
    input.addEventListener('blur', () => commit(false))
    this.options.host.appendChild(input)
    this.open_ = { input, cancel: close, commit: () => commit(false) }
    input.focus()
    input.select()
    this.options.onChange()
  }

  /** Take the number, then the caret — what a press somewhere else means. */
  commit(): void {
    this.open_?.commit()
    this.open_ = null
  }

  /**
   * Take the caret away without taking the value.
   *
   * Through the editor's own `close`, not by detaching the node: removing a
   * focused input *is* a blur, so a raw `remove()` would hand the blur handler a
   * live editor and commit a value on the way out — from a teardown, that is a
   * store write by a view that no longer exists.
   */
  close(): void {
    this.open_?.cancel()
    this.open_ = null
  }
}
