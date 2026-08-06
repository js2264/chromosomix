/**
 * A caret in a lane's small print, exactly where that print is drawn.
 *
 * Two things on a lane are a reader's rather than the file's: the range the
 * values are drawn against, and the **name** that says which lane this is. Both
 * are text painted on a canvas, and both should be changed where they are read.
 * An `<input>` is laid over the box the text was measured into, so nothing moves
 * when it becomes editable — which is the whole claim being made by putting a
 * text cursor over a picture.
 *
 * The commit rules are the point of this being a module rather than a method.
 * Each exists because of a way the obvious implementation is wrong, and a second
 * copy written beside a map would have had to rediscover all of them: opening a
 * box and not changing it is not a decision; an emptied box is that said
 * differently; a value the field refuses is refused *in place* rather than
 * swallowed into something nobody asked for; and Escape must not commit on the
 * way out, even though removing a focused node is a blur.
 *
 * What each box *means* is the caller's, and only that: a limit is a number, is
 * checked against the other end of the axis on screen, and commits to every
 * track in the lane, because a lane draws one axis under however many names it
 * holds. A name is a word, needs no checking beyond being a word, and commits to
 * the one track it names.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry } from '../annotations/types'
import type { LabelBox, LimitBox, NameBox } from '../render/laneLabel'
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

/**
 * One track's name on a lane, ready to be typed into.
 *
 * One entry and not the lane's whole set, which is the difference from
 * {@link LimitTarget} and the reason the two are separate shapes: the range
 * belongs to the lane, the name belongs to the track, and an overlaid lane draws
 * a name for each of the tracks in it.
 */
export interface NameTarget {
  entry: AnnotationEntry
  hit: NameBox
}

export interface LaneEditorOptions {
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
  /** Ask for a repaint — the canvas hides the text the box is standing on. */
  onChange(): void
}

/**
 * What a box is, told to the machinery that puts a caret in it.
 *
 * Everything here is measured or decided by the caller. The one interesting
 * member is {@link EditorSpec.apply}, which is where the two kinds of box part
 * company — and it returns a boolean rather than throwing because a refusal is
 * an ordinary answer here, not an error.
 */
interface EditorSpec {
  box: LabelBox
  /** The text's extent in reading order — see {@link NameBox.along}. */
  along: number
  /**
   * The font the text was drawn in, or `''` to leave the stylesheet's own.
   *
   * A caret that is not the size of the text it stands on moves the figure the
   * moment it opens, which is what this whole arrangement exists to prevent.
   */
  font: string
  /** Exactly what is on screen, so "unchanged" is answerable. */
  value: string
  class: string
  title: string
  /**
   * Take the typed text, or refuse it.
   *
   * `false` is refused *in place* while the reader is still typing and closed
   * silently on the way out: a blur is not a keystroke, and fighting for a focus
   * they have already moved on from is not a correction.
   */
  apply(text: string): boolean
}

export class LaneEditor {
  private open_:
    | { input: HTMLInputElement; cancel: () => void; commit: () => void }
    | null = null

  constructor(private readonly options: LaneEditorOptions) {}

  /** Whether a caret is in a lane's small print right now. */
  get isOpen(): boolean {
    return this.open_ !== null
  }

  /**
   * Put a caret in a limit.
   *
   * The other end of the pair comes from the axis on screen rather than from the
   * store, which may hold nothing: an autoscaled track has no stored pair to
   * amend, and the one the reader was looking at when they typed is the one they
   * meant.
   */
  openLimit(target: LimitTarget, offset: { left: number; top: number }): void {
    const { entries, hit } = target
    const named = entries.map((entry) => entry.label).join(', ')
    this.mount(
      {
        box: hit.box,
        along: hit.along,
        // Left to the stylesheet: the range is written at the surface's own
        // small size on both edges, and `.input.lane-edit` already matches it.
        font: '',
        value: hit.value,
        class: 'input lane-edit',
        title:
          `${hit.part === 'min' ? 'Bottom' : 'Top'} of ${named}’s value axis. ` +
          'Enter commits, Escape leaves it alone.',
        apply: (text) => {
          const typed = Number(text)
          const first = this.options.store.byId(entries[0]?.id ?? '')?.style.limits
          if (!Number.isFinite(typed) || first === undefined) return false
          const shown = this.options.shownLimits(entries[0]?.id ?? '') ?? {
            min: first.min,
            max: first.max,
          }
          const next =
            hit.part === 'min' ? { min: typed, max: shown.max } : { min: shown.min, max: typed }
          // An inverted pair is refused rather than swallowed. `resolveLimits`
          // would answer it with `{0, 1}`, which is a lane redrawn against an
          // axis nobody asked for — and the reader would be left looking for the
          // number they typed.
          if (!(next.max > next.min)) return false
          for (const entry of entries) {
            this.options.store.restyle(entry.id, { limits: { auto: false, ...next } })
          }
          return true
        },
      },
      offset,
    )
  }

  /**
   * Put a caret in a track's name.
   *
   * The name a lane opens with is a file name with its suffix taken off — a
   * starting point rather than an answer, and `Yeast_ATAC.bw` beside
   * `Yeast_ATAC.narrowPeak` arrives as two lanes called almost the same thing.
   * The side panel has been able to fix that since the beginning; what it could
   * not do is fix it *where the problem is visible*, which is a crowded figure a
   * reader is looking at rather than a column of cards beside it.
   *
   * Nothing to validate but that a word was typed: an empty or unchanged box is
   * already handled by {@link mount}, and every other string is a legal name.
   * The entry is re-read rather than trusted, because a box can stay open across
   * a frame in which the track it names was removed.
   */
  openName(target: NameTarget, offset: { left: number; top: number }): void {
    const { entry, hit } = target
    this.mount(
      {
        box: hit.box,
        along: hit.along,
        font: hit.font,
        value: hit.text,
        class: 'input lane-edit lane-edit-name',
        title:
          'What this track is called, here and in an exported figure. ' +
          'Enter commits, Escape leaves it alone.',
        apply: (text) => {
          if (this.options.store.byId(entry.id) === undefined) return false
          this.options.store.update(entry.id, { label: text })
          return true
        },
      },
      offset,
    )
  }

  /**
   * Lay a box over text the canvas has already drawn.
   *
   * `offset` converts the lane canvas's own pixels into the host's, exactly as
   * {@link LaneControls.sync} does — beside a map the stack is a grid item and
   * the layer is positioned against the grid, while in the browser the two share
   * an origin.
   */
  private mount(spec: EditorSpec, offset: { left: number; top: number }): void {
    // The one that is already open is *finished*, not abandoned. The press that
    // lands on a second box calls `preventDefault`, so it never produces the
    // focus change that would have committed the first — and cancelling here
    // would make the natural gesture for setting the same bound on two tracks in
    // a row the one gesture that silently throws the first number away. Clicking
    // anywhere *else* on the canvas already commits it; these two have to agree.
    this.open_?.commit()
    this.close()

    const [x, y] = spec.box
    const input = el('input', {
      class: spec.class,
      type: 'text',
      value: spec.value,
      title: spec.title,
    })
    input.style.left = `${Math.max(0, offset.left + x - 3)}px`
    input.style.top = `${offset.top + y - 2}px`
    // The text's extent in reading order rather than the box's width: on a
    // right-hand lane the box is turned a quarter turn, and sizing the caret
    // from it would give a twelve-pixel field for a twelve-character name.
    input.style.width = `${Math.max(44, spec.along + 22)}px`
    if (spec.font !== '') input.style.font = spec.font

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
      // Opening a box and not changing it is not a decision, and must not be
      // recorded as one. Without this, clicking a limit on an autoscaled track
      // and clicking away again takes it off autoscale for ever — at the
      // *rounded* number the label showed, which is not even the ceiling it had.
      // An emptied box is the same thing said differently: `input.select()` puts
      // the whole value under the first keystroke, so Backspace is how an edit
      // begun by accident is abandoned — and `Number('')` is `0`, which would
      // otherwise store a floor nobody typed, while `''` would leave a lane with
      // no name on it at all.
      if (text === spec.value || text === '') {
        close()
        return
      }
      if (!spec.apply(text)) {
        if (typing) refuse()
        else close()
        return
      }
      close()
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

  /** Take the text, then the caret — what a press somewhere else means. */
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
