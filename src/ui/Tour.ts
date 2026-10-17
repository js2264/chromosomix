/**
 * A guided tour over the live window (§30): the window dimmed, one control lit,
 * and a card beside it saying what to do with it.
 *
 * The tutorial is the app itself, used — not a slideshow about it and not a
 * sandbox beside it. Every step points at a real control on a real file, and
 * the reader presses it; the tour only watches. That is why a step is a pair of
 * *readings* rather than a script: {@link TourStep.target} finds what to light,
 * and {@link TourStep.done} says whether the reader has done what it asks, both
 * read live from the window on every tick. Nothing here clicks on the reader's
 * behalf or listens for a particular click: a step is done when the *state* it
 * asks for holds — the drawer open on the store, the map at 250 kb — however the
 * reader got there, by the button that is lit, a key or the palette. A tour that
 * waited for one click on one element would be stuck the moment somebody took
 * the shortcut it was about to teach.
 *
 * ## The dim, the hole, and what a click outside it does
 *
 * One ring is drawn round the target, and its shadow is the dim: a spread wide
 * enough to cover any window, so the hole and the grey are one shape and cannot
 * drift apart. Over the grey, four transparent blocks take every press that
 * lands outside the hole and answer it by pulsing the ring — the reader is shown
 * where to press rather than allowed to wander off the step by accident. Inside
 * the hole there is nothing of the tour's at all, so the control under it gets
 * the press, the drag and the wheel exactly as it would without a tour. A drag
 * that starts in the hole and runs out of it still reaches the map, whose drags
 * follow the pointer on the window: only the *starts* of a gesture are kept
 * from the app outside the hole, never its moves and ends.
 *
 * With nothing to light — a step about the whole window, or a control that is
 * not on screen yet — the grey stays and the blocks go, so the window can be
 * used to get back to where the step is.
 *
 * ## Advancing, going back, and resuming
 *
 * Entered going forward, a step that is already done is passed over, which is
 * what makes a resume cheap: it lands on the first step of the part the reader
 * left, and every step whose state still holds — the panel already open, the
 * resolution already set — goes by on its own. Entered by *back*, a done step is
 * shown and waits, so going back means looking again rather than bouncing
 * forward. A step whose surroundings have gone — the drawer it points into was
 * closed — goes back to the step that opens them ({@link TourStep.needs}).
 *
 * Above every surface of the app but below its dialogs, menus and lifted cards,
 * and it steps aside entirely while a dialog is up: a dialog owns the keyboard
 * and the reader's attention, and a tour drawn over one would be a second voice
 * talking over the first.
 */

import { button, el } from './dom'

/**
 * A step's sentences: words, with any name the reader has to read exactly — an
 * accession they will type, say — set apart in the face names are set in.
 */
export type TourText = string | ReadonlyArray<string | { name: string }>

export interface TourStep {
  /** Stable across builds: what a resume lands on (`state/tour.ts`). */
  id: string
  /** The part of the tour it belongs to, printed over its title. */
  chapter: string
  /** What to do, in a few words. */
  title: string
  /** One or two sentences: how, and what it is for. */
  text: TourText
  /**
   * What to light, read live, or `null` while it is not on screen.
   *
   * Absent on a step about the whole window, which lights nothing.
   */
  target?(): Element | null
  /**
   * Whether the reader has done what the step asks, read live.
   *
   * Absent on a step that is only read: it waits for *next*. Present, the step
   * moves on by itself a moment after this turns true.
   */
  done?(): boolean
  /**
   * What must still hold for the step to make sense — the drawer it points into,
   * the panel its row is in — and the step to go back to when it does not.
   */
  needs?: { holds(): boolean; back: string }
  /** Runs each time the step is entered: bring a row of a long table on screen, say. */
  prepare?(): void
  /** A button that does the step's typing for the reader. */
  assist?: { label: string; title: string; run(): void }
  /** Put the caret in the lit control as the step opens, for a box to type into. */
  focus?: boolean
  /** What the card says once the target has been missing for a moment. */
  missing?: string
}

export interface TourOptions {
  steps: readonly TourStep[]
  /** Where to begin, entered as a step reached going forward. */
  start: number
  /** Every step entered, so the caller can keep the reader's place. */
  onStep(step: TourStep, index: number): void
  /** The reader left before the end, or finished. */
  onEnd(how: 'skipped' | 'finished', index: number): void
  /** Whether a dialog has the window, so the tour steps aside until it closes. */
  yielding?(): boolean
}

/** A rectangle in viewport pixels. */
interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/** How long a step that has just been done stays on screen before the next. */
const SETTLE_MS = 600
/** How long a target may be missing before the card says so. */
const MISSING_MS = 1500
/** How long a step's surroundings may be gone before it goes back for them. */
const NEEDS_MS = 500
/** How often the step is read again when nothing has prompted it. */
const TICK_MS = 150
/** Air between the target and the edge of the hole. */
const PAD = 6
/** Between the hole and the card, and between the card and the window's edge. */
const GAP = 12
const MARGIN = 8

const NOT_ON_SCREEN = 'Not on screen yet. If it does not appear, go back a step.'

/** What one entry into a step has seen so far. */
interface Entry {
  /**
   * The last reading of `done`, so the step moves on when it *turns* true —
   * which is also why a done step reached by *back* waits for *next*.
   */
  was: boolean
  /** When `done` turned true, for the pause before the next step. */
  doneAt: number | null
  /** When the target was last on screen, or when the step was entered. */
  seenAt: number
  /** When `needs` stopped holding, or `null` while it holds. */
  failingSince: number | null
  /** Whether the target has been brought into view on this entry. */
  scrolled: boolean
  /** Whether the caret has been put in it on this entry. */
  focused: boolean
}

export class Tour {
  readonly el: HTMLElement
  private readonly steps: readonly TourStep[]
  private readonly options: TourOptions

  /** The grey over the whole window, for a step that lights nothing. */
  private readonly veil = el('div', { class: 'tour-veil' })
  /** The lit hole: its outline is the ring and its shadow is the grey. */
  private readonly ring = el('div', { class: 'tour-ring hidden' })
  /** Above, right of, below and left of the hole, taking the presses that land outside it. */
  private readonly blocks = [0, 1, 2, 3].map(() => el('div', { class: 'tour-block hidden' }))

  private readonly card: HTMLElement
  private readonly chapterEl = el('span', { class: 'tour-chapter' })
  private readonly countEl = el('span', { class: 'tour-count' })
  private readonly barEl = el('span', { class: 'tour-bar' })
  private readonly titleEl = el('h2', { class: 'tour-title', id: 'tour-title' })
  private readonly textEl = el('p', { class: 'tour-text', id: 'tour-text' })
  private readonly noteEl = el('p', { class: 'tour-note hidden' })
  private readonly assistSlot = el('span', { class: 'tour-assist' })
  private readonly backButton: HTMLButtonElement
  private readonly nextButton: HTMLButtonElement

  private index = 0
  private entry: Entry = freshEntry()
  private target: Element | null = null
  /** The ancestors that clip the target, found once per target. */
  private clips: Element[] = []
  /** What was last painted, so an unchanged frame writes nothing. */
  private painted = ''
  private timer: ReturnType<typeof setInterval> | null = null
  private frame: number | null = null
  private soonTimer: ReturnType<typeof setTimeout> | null = null
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(options: TourOptions) {
    this.options = options
    this.steps = options.steps

    this.backButton = button('back', () => this.previous(), {
      class: 'btn btn-quiet tour-back',
      title: 'The step before this one',
    })
    this.nextButton = button('next', () => this.next(), { class: 'btn btn-primary tour-next' })
    const skip = button('skip tutorial', () => this.end('skipped'), {
      class: 'btn btn-quiet tour-skip',
      title: 'Leave the tutorial. About picks it up where you left it.',
    })

    this.card = el(
      'div',
      {
        class: 'tour-card',
        // Not modal: the window behind it is the point, and the reader is
        // about to press something in it.
        attrs: {
          role: 'dialog',
          'aria-modal': 'false',
          'aria-labelledby': 'tour-title',
          'aria-describedby': 'tour-text',
        },
      },
      el(
        'div',
        { class: 'tour-head' },
        this.chapterEl,
        this.countEl,
        // Where a close is looked for, and saying what it does: a cross on a
        // tour reads as *pause* to some and *never again* to others, and it is
        // neither — the place is kept.
        skip,
      ),
      el('div', { class: 'tour-track', attrs: { 'aria-hidden': 'true' } }, this.barEl),
      this.titleEl,
      // Read out when it changes, so a step that moves on by itself is heard
      // as well as seen.
      el('div', { attrs: { 'aria-live': 'polite' } }, this.textEl, this.noteEl),
      el('div', { class: 'tour-actions' }, this.assistSlot, this.backButton, this.nextButton),
    )

    for (const block of this.blocks) {
      // The starts of a gesture are kept from the app; its moves and ends are
      // not, so a drag begun in the hole still ends where the map hears it.
      for (const kind of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'touchstart']) {
        block.addEventListener(kind, (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (kind === 'pointerdown') this.nudge()
        })
      }
      block.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true })
    }

    this.el = el('div', { class: 'tour' }, this.veil, this.ring, ...this.blocks, this.card)
  }

  /** The step on screen, from 0. */
  get at(): number {
    return this.index
  }

  /** Put the tour on screen at its first step. */
  start(): void {
    if (this.running) return
    this.running = true
    document.body.appendChild(this.el)
    // Read again just after anything the reader does, rather than only on the
    // tick: the step should move the moment its state holds, not up to a tick
    // later. After, because the app's own handler has to run first.
    for (const kind of ['click', 'input', 'change', 'keyup', 'pointerup']) {
      window.addEventListener(kind, this.soon, true)
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.loop()
    this.go(this.options.start, false)
  }

  /** Take the tour off screen, without a word to the caller. */
  stop(): void {
    if (!this.running) return
    this.running = false
    for (const kind of ['click', 'input', 'change', 'keyup', 'pointerup']) {
      window.removeEventListener(kind, this.soon, true)
    }
    if (this.timer !== null) clearInterval(this.timer)
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    if (this.soonTimer !== null) clearTimeout(this.soonTimer)
    if (this.nudgeTimer !== null) clearTimeout(this.nudgeTimer)
    this.timer = null
    this.frame = null
    this.el.remove()
  }

  // -------------------------------------------------------------------------
  // Moving between steps
  // -------------------------------------------------------------------------

  /**
   * Enter a step.
   *
   * Going forward, a step already done is passed over — never the last, which
   * is the one that says the tour is over and has to be seen.
   */
  private go(index: number, back: boolean): void {
    let at = Math.max(0, Math.min(this.steps.length - 1, index))
    if (!back) {
      while (at < this.steps.length - 1 && this.isDone(this.steps[at])) at++
    }
    this.index = at
    const step = this.steps[at]
    this.entry = freshEntry()
    this.entry.was = this.isDone(step)
    this.target = null
    this.clips = []
    this.painted = ''
    step.prepare?.()
    this.paintCard()
    this.options.onStep(step, at)
    this.tick()
  }

  private next(): void {
    if (this.index >= this.steps.length - 1) {
      this.end('finished')
      return
    }
    this.go(this.index + 1, false)
  }

  private previous(): void {
    if (this.index > 0) this.go(this.index - 1, true)
  }

  private end(how: 'skipped' | 'finished'): void {
    const at = this.index
    this.stop()
    this.options.onEnd(how, at)
  }

  private isDone(step: TourStep): boolean {
    try {
      return step.done?.() === true
    } catch {
      // A reading that throws is a window that is not ready to be read — a
      // panel half built — and *not done* is the answer that waits for it.
      return false
    }
  }

  // -------------------------------------------------------------------------
  // Reading the window
  // -------------------------------------------------------------------------

  /** A tick soon, after the event that asked for it has been handled. */
  private readonly soon = (): void => {
    if (this.soonTimer !== null) return
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null
      this.tick()
    }, 0)
  }

  private tick(): void {
    if (!this.running) return
    const yielding = this.options.yielding?.() === true
    this.el.classList.toggle('is-yielding', yielding)
    if (yielding) return

    const step = this.steps[this.index]
    const now = performance.now()
    const done = this.isDone(step)

    // Its surroundings went: back to the step that brings them, unless the
    // step was done anyway — a run that finishes after its drawer was closed
    // is still a run that finished.
    if (step.needs !== undefined && !done && !safely(() => step.needs?.holds() === true)) {
      this.entry.failingSince ??= now
      if (now - this.entry.failingSince >= NEEDS_MS) {
        const back = this.steps.findIndex((candidate) => candidate.id === step.needs?.back)
        if (back >= 0 && back !== this.index) {
          this.go(back, false)
          return
        }
      }
    } else {
      this.entry.failingSince = null
    }

    if (step.done !== undefined) {
      if (done && !this.entry.was) this.entry.doneAt = now
      if (!done) this.entry.doneAt = null
      this.entry.was = done
      // Never off the last step by itself, for the reason `go` never passes
      // over it: it says the tour is over, and the reader closes it.
      const last = this.index === this.steps.length - 1
      if (done && !last && this.entry.doneAt !== null && now - this.entry.doneAt >= SETTLE_MS) {
        this.next()
        return
      }
    }

    this.find(step, now)
    this.paintCard()
  }

  /** Find the target, and bring it on screen once per entry. */
  private find(step: TourStep, now: number): void {
    const found = step.target === undefined ? null : safely(() => step.target?.() ?? null)
    if (found !== this.target) {
      this.target = found
      this.clips = found === null ? [] : clipsOf(found)
    }
    if (found === null) return
    if (!this.entry.scrolled) {
      this.entry.scrolled = true
      const shown = shownBox(found, this.clips)
      const whole = found.getBoundingClientRect()
      // Only when some of it is out of sight: a scroll nobody needed moves the
      // window under a reader who was about to press the thing they could see.
      if (shown === null || area(shown) < whole.width * whole.height - 1) {
        found.scrollIntoView({ block: 'center', inline: 'nearest' })
      }
    }
    if (step.focus === true && !this.entry.focused && found instanceof HTMLElement) {
      this.entry.focused = true
      found.focus({ preventScroll: true })
    }
    if (shownBox(found, this.clips) !== null) this.entry.seenAt = now
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  /**
   * Write the card for the step on screen.
   *
   * Called on every tick, so it writes only what changed: the text is in a live
   * region, and a region rewritten with the same words is read out again by
   * some screen readers every hundred and fifty milliseconds.
   */
  private paintCard(): void {
    const step = this.steps[this.index]
    const last = this.index === this.steps.length - 1
    setText(this.chapterEl, step.chapter)
    setText(this.countEl, `step ${this.index + 1} of ${this.steps.length}`)
    const width = `${((this.index + 1) / this.steps.length) * 100}%`
    if (this.barEl.style.width !== width) this.barEl.style.width = width
    setText(this.titleEl, step.title)
    this.paintText(step.text)
    // Which step this is, for whoever reads the card rather than looks at it:
    // a test, the gallery that drives the tutorial (§30).
    if (this.card.dataset.step !== step.id) this.card.dataset.step = step.id

    // Only on a step that waits for the reader: a step that is only read and
    // has nothing to light is a sentence about the window, which is fine, and
    // one already done — reached by *back* — has often taken its control away
    // by being done: the drawer it closed is not missing.
    const missing =
      step.target !== undefined &&
      step.done !== undefined &&
      !this.entry.was &&
      shownOrNull(this.target, this.clips) === null &&
      performance.now() - this.entry.seenAt >= MISSING_MS
    setText(this.noteEl, missing ? (step.missing ?? NOT_ON_SCREEN) : '')
    this.noteEl.classList.toggle('hidden', !missing)

    if (this.assistSlot.dataset.step !== step.id) {
      this.assistSlot.dataset.step = step.id
      const assist = step.assist
      this.assistSlot.replaceChildren(
        ...(assist === undefined
          ? []
          : [button(assist.label, () => assist.run(), { class: 'btn btn-quiet', title: assist.title })]),
      )
    }

    this.backButton.disabled = this.index === 0
    // A step that waits on the reader offers to be skipped, quietly; a step
    // that is only read, or one already done, is moved on from by the one
    // button the card is inviting them to press.
    const waiting = step.done !== undefined && !this.entry.was && !last
    setText(this.nextButton, last ? 'finish' : waiting ? 'skip step' : 'next')
    const kind = waiting ? 'btn btn-quiet tour-next' : 'btn btn-primary tour-next'
    if (this.nextButton.className !== kind) this.nextButton.className = kind
    this.nextButton.title = waiting
      ? 'Go on without doing this step. The steps after it may need it.'
      : last
        ? 'Close the tutorial'
        : 'The next step'
  }

  /** The step's sentences, written only when they differ from what is there. */
  private paintText(text: TourText): void {
    const key = typeof text === 'string' ? text : JSON.stringify(text)
    if (this.textEl.dataset.text === key) return
    this.textEl.dataset.text = key
    this.textEl.replaceChildren(
      ...(typeof text === 'string' ? [text] : text).map((part) =>
        typeof part === 'string' ? document.createTextNode(part) : el('code', { class: 'tour-name', text: part.name }),
      ),
    )
  }

  /** Follow the target every frame: a column scrolling, a drawer sliding, a window resized. */
  private loop(): void {
    this.frame = requestAnimationFrame(() => {
      if (!this.running) return
      this.place()
      this.loop()
    })
  }

  private place(): void {
    const shown = shownOrNull(this.target, this.clips)
    const width = window.innerWidth
    const height = window.innerHeight
    const hole =
      shown === null
        ? null
        : {
            left: Math.max(0, shown.left - PAD),
            top: Math.max(0, shown.top - PAD),
            right: Math.min(width, shown.right + PAD),
            bottom: Math.min(height, shown.bottom + PAD),
          }
    const cardWidth = this.card.offsetWidth
    const cardHeight = this.card.offsetHeight
    const key =
      hole === null
        ? `none:${width}:${height}:${cardWidth}:${cardHeight}`
        : `${Math.round(hole.left)}:${Math.round(hole.top)}:${Math.round(hole.right)}:` +
          `${Math.round(hole.bottom)}:${width}:${height}:${cardWidth}:${cardHeight}`
    if (key === this.painted) return
    this.painted = key

    this.veil.classList.toggle('hidden', hole !== null)
    this.ring.classList.toggle('hidden', hole === null)
    for (const block of this.blocks) block.classList.toggle('hidden', hole === null)
    if (hole !== null) {
      setBox(this.ring, hole)
      const [above, right, below, left] = this.blocks
      setBox(above, { left: 0, top: 0, right: width, bottom: hole.top })
      setBox(right, { left: hole.right, top: hole.top, right: width, bottom: hole.bottom })
      setBox(below, { left: 0, top: hole.bottom, right: width, bottom: height })
      setBox(left, { left: 0, top: hole.top, right: hole.left, bottom: hole.bottom })
    }
    const at = cardPlace({ width: cardWidth, height: cardHeight }, hole, { width, height })
    this.card.style.left = `${Math.round(at.left)}px`
    this.card.style.top = `${Math.round(at.top)}px`
  }

  /** A press on the grey: show where to press instead. */
  private nudge(): void {
    this.ring.classList.remove('is-nudged')
    // Read the box between the two writes, so the animation starts again on a
    // second press rather than being a class that was already there.
    void this.ring.offsetWidth
    this.ring.classList.add('is-nudged')
    if (this.nudgeTimer !== null) clearTimeout(this.nudgeTimer)
    this.nudgeTimer = setTimeout(() => this.ring.classList.remove('is-nudged'), 700)
  }
}

/**
 * Where a tour left at step `id` starts again: the first step of that step's
 * part.
 *
 * Not the step itself, because the window may have moved on since — reloaded,
 * a drawer closed, a tab switched — and the step the reader left may point into
 * something that is no longer open. The part's first step is the one that opens
 * it, and every step after it whose state still holds goes by on its own, so a
 * window that has not moved lands exactly where the reader was. An id this
 * build has no step for starts from the beginning.
 */
export function resumeIndex(steps: readonly TourStep[], id: string): number {
  let at = steps.findIndex((step) => step.id === id)
  if (at < 0) return 0
  while (at > 0 && steps[at - 1].chapter === steps[at].chapter) at--
  return at
}

function freshEntry(): Entry {
  return {
    was: false,
    doneAt: null,
    seenAt: performance.now(),
    failingSince: null,
    scrolled: false,
    focused: false,
  }
}

function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

function safely<T>(read: () => T): T | null {
  try {
    return read()
  } catch {
    return null
  }
}

function area(box: Box): number {
  return Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top)
}

function setBox(node: HTMLElement, box: Box): void {
  node.style.left = `${box.left}px`
  node.style.top = `${box.top}px`
  node.style.width = `${Math.max(0, box.right - box.left)}px`
  node.style.height = `${Math.max(0, box.bottom - box.top)}px`
}

/**
 * Every ancestor that can hide part of a node: whatever scrolls or clips.
 *
 * Read once per target rather than per frame, since the computed style of a
 * column does not change while a reader scrolls it.
 */
export function clipsOf(node: Element): Element[] {
  const out: Element[] = []
  for (let parent = node.parentElement; parent !== null && parent !== document.body; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent)
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') out.push(parent)
  }
  return out
}

/**
 * The part of a node a reader can see: inside every ancestor that clips it and
 * inside the window, or `null` where that is nothing.
 */
export function shownBox(node: Element, clips: readonly Element[]): Box | null {
  if (!node.isConnected) return null
  const rect = node.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  if (node instanceof HTMLElement && window.getComputedStyle(node).visibility === 'hidden') return null
  let box: Box | null = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
  for (const clip of clips) {
    const outer = clip.getBoundingClientRect()
    box = intersect(box, { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom })
    if (box === null) return null
  }
  return intersect(box, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight })
}

function shownOrNull(node: Element | null, clips: readonly Element[]): Box | null {
  return node === null ? null : shownBox(node, clips)
}

function intersect(a: Box, b: Box): Box | null {
  const box = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
  return box.right - box.left < 1 || box.bottom - box.top < 1 ? null : box
}

/**
 * Where the card goes: beside the hole and clear of it.
 *
 * Below first, because the eye reads down from what it was just shown; then
 * above, right and left. A hole too big for the card to stand beside on any
 * side — a whole map — puts it in the window's bottom right corner, over the
 * least of the picture. With no hole it sits at the bottom, centred, over
 * nothing in particular.
 */
export function cardPlace(
  card: { width: number; height: number },
  hole: Box | null,
  view: { width: number; height: number },
): { left: number; top: number } {
  const clampX = (x: number): number => Math.max(MARGIN, Math.min(view.width - card.width - MARGIN, x))
  const clampY = (y: number): number => Math.max(MARGIN, Math.min(view.height - card.height - MARGIN, y))
  if (hole === null) {
    return { left: clampX((view.width - card.width) / 2), top: clampY(view.height - card.height - 3 * GAP) }
  }
  const middleX = (hole.left + hole.right) / 2 - card.width / 2
  const middleY = (hole.top + hole.bottom) / 2 - card.height / 2
  if (hole.bottom + GAP + card.height <= view.height - MARGIN) {
    return { left: clampX(middleX), top: hole.bottom + GAP }
  }
  if (hole.top - GAP - card.height >= MARGIN) {
    return { left: clampX(middleX), top: hole.top - GAP - card.height }
  }
  if (hole.right + GAP + card.width <= view.width - MARGIN) {
    return { left: hole.right + GAP, top: clampY(middleY) }
  }
  if (hole.left - GAP - card.width >= MARGIN) {
    return { left: hole.left - GAP - card.width, top: clampY(middleY) }
  }
  return { left: clampX(view.width - card.width - 2 * GAP), top: clampY(view.height - card.height - 2 * GAP) }
}
