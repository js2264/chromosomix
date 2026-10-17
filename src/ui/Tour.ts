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
 * A target may be a stretch of an element rather than the whole of it — the
 * square on a map a drag is to cross ({@link TourSpot}) — and then the hole is
 * that square, clipped to what the element shows. With nothing to light — a
 * step about the whole window, or a control that is not on screen yet — the
 * grey stays and the blocks go, so the window can be used to get back to where
 * the step is.
 *
 * ## The card
 *
 * Beside the hole, with a tail pointing into it, and gliding from one control to
 * the next rather than jumping: the eye follows the card, and the card leads it
 * to the next thing to press. Along its top, the part of the tour and the step,
 * over a bar cut into the tour's parts. Beside the title, an icon for what the
 * step asks — press, type, choose, drag, or only look — which turns into a tick
 * the moment the step is done and stays one for the beat before the next: the
 * reader sees their action land before the card moves on. A step that waits on
 * the reader breathes, a slow halo out from its ring; a step that is only read
 * does not. The first and last steps are a card in the middle of the window,
 * with no hole.
 *
 * ← and → go back and on, wherever the keys are not a control's own — a box, a
 * menu, the map — and → never skips a step that is waiting on the reader: that
 * is the *skip step* button's, pressed on purpose.
 *
 * ## Advancing, going back, and resuming
 *
 * Entered going forward, a step that is already done is passed over, which is
 * what makes a resume cheap: it lands on the first step of the part the reader
 * left, and every step whose state still holds — the panel already open, the
 * resolution already set — goes by on its own. Entered by *back*, a done step is
 * shown, ticked, and waits, so going back means looking again rather than
 * bouncing forward. A step whose surroundings have gone — the drawer it points
 * into was closed — goes back to the step that opens them ({@link TourStep.needs}).
 *
 * Above every surface of the app but below its dialogs, menus and lifted cards,
 * and it steps aside entirely while a dialog is up: a dialog owns the keyboard
 * and the reader's attention, and a tour drawn over one would be a second voice
 * talking over the first.
 */

import { withKey } from './commands'
import { button, el } from './dom'
import { icon, type IconName } from './icons'

/**
 * A step's sentences: words, with any name the reader has to read exactly — an
 * accession they will type, say — set apart in the face names are set in.
 */
export type TourText = string | ReadonlyArray<string | { name: string }>

/** What a step asks the reader to do, drawn as an icon beside its title. */
export type TourAction = 'press' | 'type' | 'choose' | 'drag' | 'look'

/** A rectangle in viewport pixels. */
export interface TourBox {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * A stretch of an element to light rather than the whole of it: the square on
 * a map a drag is to cross. Clipped to what the element shows, and the element
 * is what is brought into view.
 */
export interface TourSpot {
  within: Element
  box: TourBox
}

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
  target?(): Element | TourSpot | null
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
  /**
   * What the reader does, as the card's icon says it. Absent, a step that waits
   * on the reader is a press and one that does not is a look.
   */
  action?: TourAction
  /** A card in the middle of the window rather than beside a control: the welcome and the end. */
  hero?: boolean
  /** The primary button's word where *next* is not it — *let's go* on the welcome. */
  next?: string
  /** List the tour's parts under the sentences, as the welcome does. */
  agenda?: boolean
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

/** Which side of the hole the card stands on, for its tail. */
export type CardSide = 'below' | 'above' | 'right' | 'left' | 'over' | 'none'

/** How long a step that has just been done stays on screen, ticked, before the next. */
const SETTLE_MS = 700
/** How long a target may be missing before the card says so. */
const MISSING_MS = 1500
/** How long a step's surroundings may be gone before it goes back for them. */
const NEEDS_MS = 500
/** How often the step is read again when nothing has prompted it. */
const TICK_MS = 150
/** Air between the target and the edge of the hole. */
const PAD = 6
/** Between the hole and the card, and between the card and the window's edge. */
const GAP = 14
const MARGIN = 8
/** How close to the card's corner its tail may come. */
const TAIL_INSET = 18

const NOT_ON_SCREEN = 'Not on screen yet. If it does not appear, go back a step.'

/** The icon for each kind of step, and the word its tooltip says. */
const ACTIONS: Record<TourAction, { icon: IconName; word: string }> = {
  press: { icon: 'mouse-pointer-click', word: 'press' },
  type: { icon: 'keyboard', word: 'type' },
  choose: { icon: 'chevrons-up-down', word: 'choose' },
  drag: { icon: 'move', word: 'drag' },
  look: { icon: 'eye', word: 'look' },
}

/** Where a key is a control's own, and ← and → are left to it. */
const KEYS_OWNED =
  'input, textarea, select, canvas, [contenteditable], [role="slider"], [role="listbox"], ' +
  '[role="menu"], [role="grid"], [role="tablist"]'

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

/** One part of the tour, as the card's bar draws it. */
interface Segment {
  from: number
  count: number
  el: HTMLElement
  fill: HTMLElement
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
  private readonly tail = el('span', { class: 'tour-tail', attrs: { 'aria-hidden': 'true' } })
  private readonly chapterEl = el('span', { class: 'tour-chapter' })
  private readonly countEl = el('span', { class: 'tour-count' })
  private readonly segments: Segment[]
  /** Beside the title, for the eye: the title says what to do in words, so a screen reader is not told twice. */
  private readonly chipEl = el('span', { class: 'tour-chip', attrs: { 'aria-hidden': 'true' } })
  private readonly badgeEl = el('span', { class: 'tour-badge hidden', attrs: { 'aria-hidden': 'true' } })
  private readonly titleEl = el('h2', { class: 'tour-title', id: 'tour-title' })
  private readonly textEl = el('p', { class: 'tour-text', id: 'tour-text' })
  private readonly noteEl = el('p', { class: 'tour-note hidden' })
  private readonly agendaEl = el('ol', { class: 'tour-agenda hidden' })
  private readonly assistSlot = el('span', { class: 'tour-assist' })
  private readonly backButton: HTMLButtonElement
  private readonly nextButton: HTMLButtonElement
  private readonly nextLabel = el('span')

  private index = 0
  private entry: Entry = freshEntry()
  /** The element lit, or the element a lit spot is a stretch of. */
  private target: Element | null = null
  /** The stretch of {@link target} to light, when the step's target is a spot. */
  private spot: TourBox | null = null
  /** The ancestors that clip the target, found once per target. */
  private clips: Element[] = []
  /** What was last painted, so an unchanged frame writes nothing. */
  private painted = ''
  /** The icon drawn beside the title, so a tick rebuilds it only when it changes; `null` before the first. */
  private chip: string | null = null
  /** Whether the card has been put anywhere yet: its first place is taken, not glided to. */
  private placed = false
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
      title: withKey('The step before this one', '←'),
    })
    this.nextButton = el(
      'button',
      { class: 'btn btn-primary tour-next', type: 'button' },
      this.nextLabel,
      icon('arrow-right', { size: 14, class: 'tour-next-arrow' }),
    )
    this.nextButton.addEventListener('click', () => this.next())
    const skip = button('skip tutorial', () => this.end('skipped'), {
      class: 'btn btn-quiet tour-skip',
      title: 'Leave the tutorial. About picks it up where you left it.',
    })

    this.segments = partsOf(this.steps).map((part) => {
      const fill = el('span', { class: 'tour-segment-fill' })
      const segment = el('span', { class: 'tour-segment', attrs: { title: part.chapter } }, fill)
      segment.style.flexGrow = String(part.count)
      return { from: part.from, count: part.count, fill, el: segment }
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
      this.tail,
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
      el(
        'div',
        { class: 'tour-track', attrs: { 'aria-hidden': 'true' } },
        ...this.segments.map((segment) => segment.el),
      ),
      el(
        'div',
        { class: 'tour-body' },
        this.badgeEl,
        el('div', { class: 'tour-heading' }, this.chipEl, this.titleEl),
        // Read out when it changes, so a step that moves on by itself is heard
        // as well as seen.
        el('div', { class: 'tour-live', attrs: { 'aria-live': 'polite' } }, this.textEl, this.noteEl),
        this.agendaEl,
      ),
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
    // Bubbling, and after the app: a key a control has answered is not ours.
    window.addEventListener('keydown', this.onKey)
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
    window.removeEventListener('keydown', this.onKey)
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
    this.spot = null
    this.clips = []
    this.painted = ''
    step.prepare?.()
    this.paintCard()
    // The words come in rather than being swapped under the reader's eye.
    this.card.classList.remove('is-entering')
    void this.card.offsetWidth
    this.card.classList.add('is-entering')
    // A card in the middle of the window is a dialog in all but name, and its
    // one button is what Enter should press.
    if (step.hero === true) this.nextButton.focus({ preventScroll: true })
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

  /** Whether the step on screen is waiting on the reader, so *next* would skip it. */
  private waiting(): boolean {
    const step = this.steps[this.index]
    return step.done !== undefined && !this.entry.was && this.index < this.steps.length - 1
  }

  /** ← and →, wherever they are not a control's own. */
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    if (this.options.yielding?.() === true) return
    const at = event.target
    if (at instanceof Element && at.closest(KEYS_OWNED) !== null) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      this.previous()
    } else if (!this.waiting()) {
      event.preventDefault()
      this.next()
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
    const element = found === null ? null : isSpot(found) ? found.within : found
    this.spot = found !== null && isSpot(found) ? found.box : null
    if (element !== this.target) {
      this.target = element
      this.clips = element === null ? [] : clipsOf(element)
    }
    if (element === null) return
    if (!this.entry.scrolled) {
      this.entry.scrolled = true
      const shown = this.lit()
      // A spot is measured within its element: a square running past the edge
      // of the map is cut by the map, and no scroll brings that part back.
      const rect = boxOf(element.getBoundingClientRect())
      const whole = this.spot === null ? rect : intersect(this.spot, rect)
      // Only when some of it is out of sight: a scroll nobody needed moves the
      // window under a reader who was about to press the thing they could see.
      if (whole !== null && (shown === null || area(shown) < area(whole) - 1)) {
        element.scrollIntoView({ block: 'center', inline: 'nearest' })
      }
    }
    if (step.focus === true && !this.entry.focused && element instanceof HTMLElement) {
      this.entry.focused = true
      element.focus({ preventScroll: true })
    }
    if (this.lit() !== null) this.entry.seenAt = now
  }

  /** What of the target a reader can see: the element, or the stretch of it a spot names. */
  private lit(): TourBox | null {
    const shown = shownOrNull(this.target, this.clips)
    if (shown === null || this.spot === null) return shown
    return intersect(shown, this.spot)
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
    const hero = step.hero === true
    const done = step.done !== undefined && this.entry.was
    setText(this.chapterEl, step.chapter)
    setText(this.countEl, `step ${this.index + 1} of ${this.steps.length}`)
    for (const segment of this.segments) {
      const share = Math.max(0, Math.min(1, (this.index - segment.from + 1) / segment.count))
      const width = `${share * 100}%`
      if (segment.fill.style.width !== width) segment.fill.style.width = width
    }
    setText(this.titleEl, step.title)
    this.paintText(step.text)
    // Which step this is, for whoever reads the card rather than looks at it:
    // a test, the gallery that drives the tutorial (§30).
    if (this.card.dataset.step !== step.id) this.card.dataset.step = step.id
    this.card.classList.toggle('is-hero', hero)
    this.el.classList.toggle('is-done', done)
    // A ring that breathes says *press here*; one that is only showing a thing
    // to look at, or a thing already done, holds still.
    this.el.classList.toggle('is-waiting', !hero && this.waiting())
    this.paintChip(hero ? '' : done ? 'done' : (step.action ?? (step.done === undefined ? 'look' : 'press')))
    this.badgeEl.classList.toggle('hidden', !(hero && last))
    if (hero && last && this.badgeEl.childElementCount === 0) this.badgeEl.append(icon('check', { size: 26 }))
    this.paintAgenda(step)

    // Only on a step that waits for the reader: a step that is only read and
    // has nothing to light is a sentence about the window, which is fine, and
    // one already done — reached by *back* — has often taken its control away
    // by being done: the drawer it closed is not missing.
    const missing =
      step.target !== undefined &&
      step.done !== undefined &&
      !this.entry.was &&
      this.lit() === null &&
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

    // Gone rather than greyed on the first card: there is nothing before it,
    // and a dead button beside *let's go* is one more thing to read.
    this.backButton.disabled = this.index === 0
    this.backButton.classList.toggle('hidden', this.index === 0)
    // A step that waits on the reader offers to be skipped, quietly; a step
    // that is only read, or one already done, is moved on from by the one
    // button the card is inviting them to press.
    const waiting = this.waiting()
    setText(this.nextLabel, step.next ?? (last ? 'finish' : waiting ? 'skip step' : 'next'))
    const kind = waiting ? 'btn btn-quiet tour-next' : 'btn btn-primary tour-next'
    if (this.nextButton.className !== kind) this.nextButton.className = kind
    this.nextButton.classList.toggle('is-last', last)
    this.nextButton.title = waiting
      ? 'Go on without doing this step. The steps after it may need it.'
      : last
        ? 'Close the tutorial'
        : withKey('The next step', '→')
  }

  /** The icon beside the title: what the step asks, or a tick once it is done. */
  private paintChip(state: string): void {
    if (state === this.chip) return
    this.chip = state
    this.chipEl.classList.toggle('hidden', state === '')
    this.chipEl.classList.toggle('is-done', state === 'done')
    if (state === '') {
      this.chipEl.replaceChildren()
      return
    }
    const action = state === 'done' ? null : ACTIONS[state as TourAction]
    this.chipEl.replaceChildren(icon(action === null ? 'check' : action.icon, { size: 14 }))
    this.chipEl.title = action === null ? 'done' : action.word
  }

  /**
   * The tour's parts, under the welcome's sentences — the ones with something
   * to do in them, which leaves out the welcome itself and the end.
   */
  private paintAgenda(step: TourStep): void {
    const shown = step.agenda === true
    this.agendaEl.classList.toggle('hidden', !shown)
    if (!shown || this.agendaEl.dataset.step === step.id) return
    this.agendaEl.dataset.step = step.id
    const parts = partsOf(this.steps).filter((part) =>
      this.steps.slice(part.from, part.from + part.count).some((one) => one.hero !== true),
    )
    this.agendaEl.replaceChildren(...parts.map((part) => el('li', { text: part.chapter })))
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
    const step = this.steps[this.index]
    const hero = step.hero === true
    const shown = hero ? null : this.lit()
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
      (hero ? 'hero:' : '') +
      (hole === null
        ? `none:${width}:${height}:${cardWidth}:${cardHeight}`
        : `${Math.round(hole.left)}:${Math.round(hole.top)}:${Math.round(hole.right)}:` +
          `${Math.round(hole.bottom)}:${width}:${height}:${cardWidth}:${cardHeight}`)
    if (key === this.painted) return
    this.painted = key

    const appearing = hole !== null && this.ring.classList.contains('hidden')
    this.veil.classList.toggle('hidden', hole !== null)
    this.ring.classList.toggle('hidden', hole === null)
    for (const block of this.blocks) block.classList.toggle('hidden', hole === null)
    if (hole !== null) {
      // A hole that opens is drawn where it is, not slid in from wherever the
      // last one closed.
      snap(this.ring, appearing, () => setBox(this.ring, hole))
      const [above, right, below, left] = this.blocks
      setBox(above, { left: 0, top: 0, right: width, bottom: hole.top })
      setBox(right, { left: hole.right, top: hole.top, right: width, bottom: hole.bottom })
      setBox(below, { left: 0, top: hole.bottom, right: width, bottom: height })
      setBox(left, { left: 0, top: hole.top, right: hole.left, bottom: hole.bottom })
    }
    const size = { width: cardWidth, height: cardHeight }
    const view = { width, height }
    const at = hero ? heroPlace(size, view) : cardPlace(size, hole, view)
    snap(this.card, !this.placed, () => {
      this.card.style.left = `${Math.round(at.left)}px`
      this.card.style.top = `${Math.round(at.top)}px`
    })
    this.placed = true
    if (this.card.dataset.side !== at.side) this.card.dataset.side = at.side
    if (hole !== null) {
      const across = at.side === 'below' || at.side === 'above'
      const reach = across
        ? (hole.left + hole.right) / 2 - at.left
        : (hole.top + hole.bottom) / 2 - at.top
      const span = across ? cardWidth : cardHeight
      const tail = Math.max(TAIL_INSET, Math.min(span - TAIL_INSET, reach))
      this.card.style.setProperty('--tail-at', `${Math.round(tail)}px`)
    }
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

/** The tour's parts, in order: each one's name, its first step and how many steps it has. */
export function partsOf(steps: readonly TourStep[]): Array<{ chapter: string; from: number; count: number }> {
  const parts: Array<{ chapter: string; from: number; count: number }> = []
  steps.forEach((step, at) => {
    const last = parts[parts.length - 1]
    if (last !== undefined && last.chapter === step.chapter) last.count++
    else parts.push({ chapter: step.chapter, from: at, count: 1 })
  })
  return parts
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

function isSpot(target: Element | TourSpot): target is TourSpot {
  return !(target instanceof Element)
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

/**
 * Make a change with the element's glide turned off, when `now` says so: the
 * first place a card or a ring takes is taken, not slid to from wherever its
 * box was before it was shown.
 */
function snap(node: HTMLElement, now: boolean, change: () => void): void {
  if (!now) {
    change()
    return
  }
  node.classList.add('is-snapping')
  change()
  void node.offsetWidth
  node.classList.remove('is-snapping')
}

function boxOf(rect: DOMRectReadOnly): TourBox {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

function area(box: TourBox): number {
  return Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top)
}

function setBox(node: HTMLElement, box: TourBox): void {
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
export function shownBox(node: Element, clips: readonly Element[]): TourBox | null {
  if (!node.isConnected) return null
  const rect = node.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return null
  if (node instanceof HTMLElement && window.getComputedStyle(node).visibility === 'hidden') return null
  let box: TourBox | null = boxOf(rect)
  for (const clip of clips) {
    box = intersect(box, boxOf(clip.getBoundingClientRect()))
    if (box === null) return null
  }
  return intersect(box, { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight })
}

function shownOrNull(node: Element | null, clips: readonly Element[]): TourBox | null {
  return node === null ? null : shownBox(node, clips)
}

function intersect(a: TourBox, b: TourBox): TourBox | null {
  const box = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  }
  return box.right - box.left < 1 || box.bottom - box.top < 1 ? null : box
}

/**
 * Where the card goes: beside the hole and clear of it, and which side that is.
 *
 * Below first, because the eye reads down from what it was just shown; then
 * above, right and left. A hole too big for the card to stand beside on any
 * side — a whole map — puts it in the window's bottom right corner, over the
 * least of the picture. With no hole it sits at the bottom, centred, over
 * nothing in particular.
 */
export function cardPlace(
  card: { width: number; height: number },
  hole: TourBox | null,
  view: { width: number; height: number },
): { left: number; top: number; side: CardSide } {
  const clampX = (x: number): number => Math.max(MARGIN, Math.min(view.width - card.width - MARGIN, x))
  const clampY = (y: number): number => Math.max(MARGIN, Math.min(view.height - card.height - MARGIN, y))
  if (hole === null) {
    return {
      left: clampX((view.width - card.width) / 2),
      top: clampY(view.height - card.height - 3 * GAP),
      side: 'none',
    }
  }
  const middleX = (hole.left + hole.right) / 2 - card.width / 2
  const middleY = (hole.top + hole.bottom) / 2 - card.height / 2
  if (hole.bottom + GAP + card.height <= view.height - MARGIN) {
    return { left: clampX(middleX), top: hole.bottom + GAP, side: 'below' }
  }
  if (hole.top - GAP - card.height >= MARGIN) {
    return { left: clampX(middleX), top: hole.top - GAP - card.height, side: 'above' }
  }
  if (hole.right + GAP + card.width <= view.width - MARGIN) {
    return { left: hole.right + GAP, top: clampY(middleY), side: 'right' }
  }
  if (hole.left - GAP - card.width >= MARGIN) {
    return { left: hole.left - GAP - card.width, top: clampY(middleY), side: 'left' }
  }
  return {
    left: clampX(view.width - card.width - 2 * GAP),
    top: clampY(view.height - card.height - 2 * GAP),
    side: 'over',
  }
}

/** Where a card in the middle of the window goes: centred, a little above the middle, as a dialog is. */
export function heroPlace(
  card: { width: number; height: number },
  view: { width: number; height: number },
): { left: number; top: number; side: CardSide } {
  return {
    left: Math.max(MARGIN, (view.width - card.width) / 2),
    top: Math.max(MARGIN, (view.height - card.height) / 2 - view.height * 0.06),
    side: 'none',
  }
}
