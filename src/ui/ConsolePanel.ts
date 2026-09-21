/**
 * The console: what this window has done, along the bottom of it (§23).
 *
 * A panel rather than a page, and the *same kind of panel the Analysis drawer
 * is* — because it answers the same objection. It floats over the body with a
 * shadow to say so, it is dragged by the edge that faces the map, Escape puts it
 * down, and it takes neither the keyboard nor a click outside itself. Every
 * shortcut keeps working behind it, so reading back this morning's commands
 * while panning the map is an ordinary thing to do rather than a mode to leave
 * first (§18.1 makes the argument; this is the second surface to take it).
 *
 * **It is along the bottom because the log is wide and shallow.** A command line
 * is one long line and there are a few dozen of them in a day: in a column it
 * wraps four times per entry and shows six of them, and under the map it reads
 * as what it is, a terminal's scrollback. That is also why the day it belongs to
 * is a **separator across the list** rather than a column — the question this
 * panel exists to answer is "what did I run today", and a heading a reader can
 * copy a whole day from is the answer in one press.
 *
 * It is also what lets the two be up at once: the drawer down the right, the
 * console along the bottom, and the map in the corner between them. The corner
 * is the one place they would fight over, and {@link ConsolePanel.paintHeight}
 * is where that is settled — the drawer stops at this panel's roof rather than
 * running under it.
 *
 * ## What is drawn, and what a row is
 *
 * The rows are `state/actions.ts`'s entries and nothing else — this file adds no
 * facts, and in particular does not decide what a run's command *is*. That is
 * written where a run happens, from the same `Provenance` every export carries,
 * which is the whole of why a line here and the `copy CLI command` button in the
 * drawer cannot drift: they are one function called twice.
 *
 * **A run of one task over six maps is six rows.** The runner records a job, and
 * *run on all maps* is six jobs — so what the console shows is what the machine
 * did rather than what the button was called. The alternative, one row per press
 * with the maps folded into it, is a line nobody can paste.
 *
 * ## The output toggle
 *
 * A command says what was asked for; the provenance block says everything about
 * the run that a command line cannot carry — the build, the task's version, the
 * framing in words, and every parameter one per line, which is the header every
 * exported TSV already opens with. It is *off* by default because eleven lines
 * of `#` per row is a log nobody scans, and it is a toggle rather than a second
 * panel because the two things a reader wants — a clean column of commands to
 * paste, and the full record of one of them — are the same rows with more or
 * less shown. Copy and save honour it, so the toggle is also the choice between
 * a script and an archive.
 */

import { button, el, fmt } from './dom'
import { durationText } from '../units'
import { KEYS, withKey } from './commands'
import { copyTextToClipboard, downloadBlob, fileStamp } from './export'
import { icon, iconButton, type IconName } from './icons'
import { resizeHandle } from './resizeHandle'
import { messageToast } from './toast'
import {
  actionCount,
  actionLines,
  actions,
  actionsText,
  clearActions,
  dayOf,
  subscribeActions,
  timeOf,
  type ActionKind,
  type ActionStatus,
  type LoggedAction,
} from '../state/actions'

/**
 * Where the dragged height and the two preferences are kept.
 *
 * `localStorage`, on the reasoning `AnalysisDrawer` gives for its width and
 * `SidePanel` for a column's fold: how tall a reader likes this panel, whether
 * they keep it open and whether they read the provenance with it are
 * preferences about *this window*, not a train of thought about a file.
 */
const HEIGHT_KEY = 'metacooler-viewer:console:height'
const OPEN_KEY = 'metacooler-viewer:console:open'
const OUTPUT_KEY = 'metacooler-viewer:console:output'

/** Below this the header and one row do not both fit. */
const MIN_HEIGHT = 140
const DEFAULT_FRACTION = 0.32
/** Not 1: a strip of map showing is what says this is a panel and not a page. */
const MAX_FRACTION = 0.9

/** The mark on a row, by what kind of thing happened. */
const MARK: Record<ActionKind, IconName> = {
  run: 'play',
  open: 'file',
  track: 'layers',
  write: 'download',
}

/** What a row's mark is announced as, for a reader who cannot see it. */
const KIND_LABEL: Record<ActionKind, string> = {
  run: 'analysis run',
  open: 'file opened',
  track: 'track loaded',
  write: 'file written',
}

const STATUS_LABEL: Record<ActionStatus, string> = {
  running: 'running',
  ok: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
  interrupted: 'the window closed while this was running',
}

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/*
 * Three writers rather than one taking the key, and the repetition is the
 * point.
 *
 * `test/unit/stored.test.ts` reads every `setItem` in `src/` and resolves the
 * key, so that a future line writing outside the prefix fails there rather than
 * surviving a "forget everything" that claims to be total. A helper whose key
 * arrives as a parameter is exactly what it cannot follow — it pins the four
 * that already exist so that a fifth is a decision somebody makes on purpose,
 * and there is no reason for this file to be the fifth. Written out, the rule
 * covers these three statically, with no exception to maintain.
 */
function writeHeight(value: number | null): void {
  try {
    if (value === null) window.localStorage.removeItem(HEIGHT_KEY)
    else window.localStorage.setItem(HEIGHT_KEY, String(Math.round(value)))
  } catch {
    /* a browser that refuses storage still resizes correctly for this session */
  }
}

function writeOpen(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(OPEN_KEY, '1')
    else window.localStorage.removeItem(OPEN_KEY)
  } catch {
    /* as above */
  }
}

function writeOutput(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(OUTPUT_KEY, '1')
    else window.localStorage.removeItem(OUTPUT_KEY)
  } catch {
    /* as above */
  }
}

/** `2026-09-11` as a reader thinks of it, which for two of the days is a word. */
function dayLabel(day: string, now: number): string {
  if (day === dayOf(now)) return 'today'
  if (day === dayOf(now - 24 * 60 * 60 * 1000)) return 'yesterday'
  return day
}

/**
 * Everything about an entry that changes what its row looks like.
 *
 * A repaint reuses the row it already built when this string has not moved,
 * which is what keeps a running job — repainted on every state change — from
 * rebuilding five hundred rows underneath the one that moved.
 */
function signatureOf(entry: LoggedAction, output: boolean): string {
  return [
    entry.status,
    entry.line,
    entry.ms ?? '',
    entry.error ?? '',
    entry.notes.length,
    output ? entry.detail.length : 0,
  ].join(' ')
}

export interface ConsolePanelOptions {
  /**
   * The panel opened or closed, so the shell can tell the mounted view.
   *
   * A `ResizeObserver` inside the view cannot see all of it: a plot is usually
   * sized by the window's *height*, and this takes a third of it — the same
   * reason `App` hands the columns a `relayout`.
   */
  onLayout?(): void
}

export class ConsolePanel {
  readonly el: HTMLElement
  /** The header button. The shell puts it where §23 says. */
  readonly toggle: HTMLButtonElement

  private readonly listEl = el('div', { class: 'console-list' })
  private readonly countEl = el('span', { class: 'console-count' })
  private readonly outputBox: HTMLInputElement
  private readonly emptyEl: HTMLElement
  private readonly unsubscribe: () => void
  private readonly options: ConsolePanelOptions

  private opened = false
  private height: number | null = readNumber(HEIGHT_KEY)
  private output = readFlag(OUTPUT_KEY)
  /** Rows already built, by entry id — see {@link signatureOf}. */
  private rows = new Map<string, { node: HTMLElement; signature: string }>()

  constructor(options: ConsolePanelOptions = {}) {
    this.options = options
    this.toggle = el('button', {
      class: 'btn btn-icon',
      type: 'button',
      attrs: { 'aria-label': 'console' },
    })
    this.toggle.addEventListener('click', () => this.setOpen(!this.opened))

    this.outputBox = el('input', { type: 'checkbox', class: 'console-output-box' })
    this.outputBox.checked = this.output
    this.outputBox.addEventListener('change', () => {
      this.output = this.outputBox.checked
      writeOutput(this.output)
      // Every row's signature changed, so the reconcile below would rebuild them
      // one by one anyway; dropping them first says so in one line.
      this.rows.clear()
      this.listEl.replaceChildren()
      this.paint()
    })

    this.emptyEl = el('p', {
      class: 'console-empty',
      text:
        'Nothing yet. Every analysis run lands here as the command that repeats it — one line ' +
        'per map, so a run over a deck is a line each — beside the files opened, the tracks ' +
        'loaded and the files written. Kept for a week, in this browser, and never sent anywhere.',
    })

    this.el = el(
      'div',
      {
        // The stylesheet's own word for a surface that is not showing, shared
        // with the four columns and the drawer: one class, one meaning.
        class: 'console-drawer collapsed',
        attrs: { role: 'region', 'aria-label': 'console' },
      },
      this.handle(),
      el(
        'div',
        { class: 'console-head' },
        icon('terminal', { size: 14, class: 'console-head-mark' }),
        el('h2', { class: 'console-title', text: 'Console' }),
        this.countEl,
        el(
          'label',
          {
            class: 'console-output',
            title:
              'Print each entry’s provenance above it — the build, the task and its version, ' +
              'the framing and every parameter, one per line. The same header every exported ' +
              'file opens with, and what copying and saving take with them while it is on.',
          },
          this.outputBox,
          el('span', { text: 'output' }),
        ),
        button('copy', () => this.copyAll(), {
          class: 'btn btn-quiet',
          title: 'Every line, as a script: the commands bare and everything else commented.',
        }),
        button('save', () => this.save(), {
          class: 'btn btn-quiet',
          title: 'The same text, as a file.',
        }),
        button('clear', () => this.clear(), {
          class: 'btn btn-quiet',
          title: 'Forget every line. Anything still running keeps running.',
        }),
        iconButton('x', 'Close the console. Nothing stops recording.', () => this.setOpen(false), {
          class: 'btn-close',
          size: 14,
        }),
      ),
      this.listEl,
    )

    this.unsubscribe = subscribeActions(() => this.onChanged())
    window.addEventListener('keydown', this.onKeyDown)
    // The height is a number of pixels the reader dragged, and its ceiling is a
    // fraction of a window that can be made smaller afterwards. The stylesheet
    // caps it either way; this is what puts it back where the reader wanted it
    // when the window grows again.
    window.addEventListener('resize', this.onResize)
    this.paintToggle()
    // Restored like a column's fold: how a reader leaves this window is a
    // preference about it. The embed does not arise here — `App` builds no
    // console at all in one — which is why this reads the preference plainly
    // rather than guarding it the way `state/actions.ts` guards its writes.
    if (readFlag(OPEN_KEY)) this.setOpen(true)
  }

  get isOpen(): boolean {
    return this.opened
  }

  setOpen(open: boolean): void {
    if (this.opened === open) {
      this.paintToggle()
      return
    }
    this.opened = open
    this.el.classList.toggle('collapsed', !open)
    writeOpen(open)
    this.paintToggle()
    if (open) {
      this.paintHeight()
      this.paint()
      this.scrollToEnd()
    } else {
      // Removed rather than set to zero, so the drawer falls back to the `0px`
      // its own rule names and there is no state to keep in step.
      this.host()?.style.removeProperty('--console-height')
    }
    this.options.onLayout?.()
  }

  /** The window or a column moved, so the height's ceiling has. */
  relayout(): void {
    if (this.opened) this.paintHeight()
  }

  destroy(): void {
    this.unsubscribe()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('resize', this.onResize)
    this.el.remove()
  }

  private readonly onResize = (): void => this.relayout()

  /**
   * Escape puts the console down, on the drawer's terms and for its reasons.
   *
   * The **bubble** phase and never an event something has already handled, so a
   * marquee on the map, a caret in a search box and an open dropdown all keep
   * the Escape they answer first. There is one difference from the drawer, and
   * it is that this panel has no fields to abandon: nothing in it takes text, so
   * there is nothing here that outranks the dismissal.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (!this.opened) return
    event.preventDefault()
    this.setOpen(false)
  }

  private paintToggle(): void {
    const held = actionCount()
    this.toggle.replaceChildren(icon('terminal'))
    const count = held === 0 ? 'nothing recorded yet' : `${fmt.int(held)} recorded`
    this.toggle.title = withKey(
      `${this.opened ? 'Close' : 'Open'} the console — every run, open and export, as commands ` +
        `(${count})`,
      KEYS.console,
    )
    this.toggle.setAttribute('aria-expanded', String(this.opened))
  }

  private onChanged(): void {
    this.paintToggle()
    // A closed console paints nothing: a batch over thirty maps would otherwise
    // build sixty rows nobody is looking at, and opening it repaints from the
    // log anyway.
    if (this.opened) this.paint()
  }

  // -------------------------------------------------------------------------
  // Height
  // -------------------------------------------------------------------------

  private handle(): HTMLElement {
    return resizeHandle({
      // The edge that faces the map, so dragging up makes it taller.
      side: 'top',
      what: 'console',
      width: () => this.heightNow(),
      resize: (px) => {
        this.height = px
        this.paintHeight()
      },
      // The *effective* height, not the raw one the pointer asked for: a drag
      // that ran off the top of the window would otherwise store a number this
      // window never honoured, and the panel would jump to it on a taller screen.
      commit: () => writeHeight(this.heightNow()),
      reset: () => {
        this.height = null
        writeHeight(null)
        this.paintHeight()
      },
    })
  }

  /** The body the console is laid over, which is what the fractions are of. */
  private bodyHeight(): number {
    const host = this.el.closest('.app-body') ?? this.el.parentElement
    const height = host?.getBoundingClientRect().height ?? 0
    return height > 0 ? height : window.innerHeight
  }

  private heightNow(): number {
    const body = this.bodyHeight()
    const max = Math.round(body * MAX_FRACTION)
    // The floor gives way to the ceiling, as the drawer's does: on a window
    // shorter than the minimum, 90% of it is the honest answer.
    const floor = Math.min(MIN_HEIGHT, max)
    return Math.max(floor, Math.min(max, this.height ?? Math.round(body * DEFAULT_FRACTION)))
  }

  /**
   * Write the height, and tell the body about it.
   *
   * The custom property is what keeps the **Analysis drawer** off the console's
   * roof. Both float over the body rather than joining the flex row — one down
   * the right edge, one along the bottom — so at their full sizes they overlap
   * in the corner, and the loser was the drawer's run row: `run`, `run on all
   * maps` and the cancel beside them, under a panel listing the runs they start.
   * The drawer's `bottom` reads this, so opening the console shortens it and
   * closing the console gives the room back.
   *
   * Only the drawer. The columns and the map are *overlaid*, which is what a
   * drawer does and what the Analysis drawer already does to the two columns it
   * covers — a console that shortened the body would re-lay-out the heatmap on
   * every pixel of a drag, which is the arithmetic §18.1 refuses for the same
   * reason.
   */
  private paintHeight(): void {
    const px = this.heightNow()
    this.el.style.height = `${px}px`
    this.host()?.style.setProperty('--console-height', `${px}px`)
  }

  /** The positioned box both floating panels are measured against. */
  private host(): HTMLElement | null {
    const found = this.el.closest('.app-body') ?? this.el.parentElement
    return found instanceof HTMLElement ? found : null
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  /**
   * Whether the reader is reading the newest line.
   *
   * Asked *before* the paint, because the answer decides whether the paint
   * scrolls: a console that jumps to the bottom while somebody is reading an
   * hour ago is a console they have to fight, and one that does not follow a
   * running batch is a progress display nobody can see.
   */
  private atEnd(): boolean {
    const slack = this.listEl.scrollHeight - this.listEl.scrollTop - this.listEl.clientHeight
    return slack < 32
  }

  private scrollToEnd(): void {
    this.listEl.scrollTop = this.listEl.scrollHeight
  }

  private paint(): void {
    const held = actions()
    const follow = this.atEnd()
    const now = Date.now()
    this.countEl.textContent =
      held.length === 0
        ? ''
        : `${fmt.int(held.length)} line${held.length === 1 ? '' : 's'}, newest last`

    const wanted: HTMLElement[] = []
    const keep = new Map<string, { node: HTMLElement; signature: string }>()
    let day = ''
    for (const entry of held) {
      const own = dayOf(entry.at)
      if (own !== day) {
        day = own
        const key = `day:${own}`
        const heading = this.dayHeading(own, now)
        keep.set(key, { node: heading, signature: own })
        wanted.push(heading)
      }
      const signature = signatureOf(entry, this.output)
      const had = this.rows.get(entry.id)
      // Reused unless something about it moved. A batch of thirty repaints on
      // every job's two edges, and rebuilding the other twenty-nine rows each
      // time is what makes a console stutter while the work it is reporting runs.
      const node = had !== undefined && had.signature === signature ? had.node : this.row(entry)
      keep.set(entry.id, { node, signature })
      wanted.push(node)
    }
    this.rows = keep
    this.listEl.replaceChildren(...(wanted.length === 0 ? [this.emptyEl] : wanted))
    if (follow) this.scrollToEnd()
  }

  /**
   * The separator between two days, and the way to take one away whole.
   *
   * The count and the copy are on the heading rather than beside the panel's own
   * because the unit a reader asks for is a *day*: "the commands I ran on
   * Tuesday" is one press here, and "all of them" is the button in the header.
   *
   * Rebuilt on every paint rather than reused, unlike the rows: its count moves
   * whenever anything is recorded, so a heading kept for its key would be a
   * number that goes stale the moment the day it names is still being worked.
   */
  private dayHeading(day: string, now: number): HTMLElement {
    const count = actions().filter((entry) => dayOf(entry.at) === day).length
    return el(
      'div',
      { class: 'console-day' },
      el('span', { class: 'console-day-name', text: dayLabel(day, now) }),
      el('span', {
        class: 'console-day-count',
        text: `${fmt.int(count)} line${count === 1 ? '' : 's'}`,
      }),
      button('copy this day', () => this.copyDay(day), {
        class: 'btn btn-quiet console-day-copy',
        title: `Everything from ${day}, in the order it happened.`,
      }),
    )
  }

  private row(entry: LoggedAction): HTMLElement {
    const lines = el('div', { class: 'console-lines' })
    // The order the text is copied in, so what is on screen and what lands on
    // the clipboard are the same document read two ways: the provenance first,
    // then the caveats **above a command** — and below a line that is not one,
    // where the note is the reason there is no command rather than a warning
    // about running it (see `LoggedAction.notes`).
    if (this.output) {
      for (const line of entry.detail) {
        lines.appendChild(el('div', { class: 'console-detail', text: line }))
      }
    }
    const note = (text: string): HTMLElement => el('div', { class: 'console-note', text })
    if (entry.shell) for (const text of entry.notes) lines.appendChild(note(text))
    lines.appendChild(
      el('div', {
        class: entry.shell ? 'console-line is-shell' : 'console-line',
        text: entry.line,
      }),
    )
    if (!entry.shell) for (const text of entry.notes) lines.appendChild(note(text))
    if (entry.error !== undefined) {
      lines.appendChild(el('div', { class: 'console-error', text: entry.error }))
    }

    const meta = el('div', { class: 'console-meta' })
    if (entry.where !== undefined) {
      meta.appendChild(el('span', { class: 'console-where', text: entry.where }))
    }
    if (entry.ms !== undefined) {
      meta.appendChild(el('span', { class: 'console-ms', text: durationText(entry.ms) }))
    }

    return el(
      'div',
      {
        class: `console-row is-${entry.status}`,
        attrs: { 'data-kind': entry.kind },
      },
      el('span', { class: 'console-time', text: timeOf(entry.at) }),
      el(
        'span',
        {
          class: 'console-mark',
          title: `${KIND_LABEL[entry.kind]} — ${STATUS_LABEL[entry.status]}`,
        },
        entry.status === 'running'
          ? el('span', { class: 'analysis-spinner' })
          : icon(MARK[entry.kind], { size: 13 }),
      ),
      lines,
      meta,
      iconButton('clipboard-copy', 'Copy this line', () => this.copyOne(entry), {
        class: 'btn btn-icon console-row-copy',
        size: 13,
      }),
    )
  }

  // -------------------------------------------------------------------------
  // Taking it away
  // -------------------------------------------------------------------------

  private copyOne(entry: LoggedAction): void {
    // The same builder the whole log is written with, so a row copied on its own
    // and the same row inside a copied day are the same lines in the same order.
    const lines = actionLines(entry, { detail: this.output })
    this.copy(lines.join('\n'), entry.shell ? 'Command copied.' : 'Line copied.')
  }

  private copyAll(): void {
    const text = actionsText({ detail: this.output })
    if (text === '') {
      messageToast('There is nothing recorded yet.')
      return
    }
    this.copy(text, 'The whole console is on the clipboard.')
  }

  private copyDay(day: string): void {
    const text = actionsText({ detail: this.output, day })
    if (text === '') return
    this.copy(text, `${dayLabel(day, Date.now())} is on the clipboard.`)
  }

  private copy(text: string, said: string): void {
    void copyTextToClipboard(text).then(
      () => messageToast(said),
      (err: unknown) => messageToast(err instanceof Error ? err.message : String(err)),
    )
  }

  /**
   * The log as a file.
   *
   * `.sh`, because that is what it is: the commands are bare and everything else
   * is a `#` comment, so a day saved out of here runs. Recorded like every other
   * export — a console that wrote a file and did not say so would be the one
   * place in the app where a file leaves without a line about it.
   */
  private save(): void {
    const text = actionsText({ detail: this.output })
    if (text === '') {
      messageToast('There is nothing recorded yet.')
      return
    }
    const head =
      `#!/bin/sh\n# metacooler.js console, saved ${new Date().toISOString()}\n` +
      '# Commands are bare; everything else is a comment.\n\n'
    downloadBlob(
      new Blob([head, text], { type: 'text/x-shellscript' }),
      `metacooler-console-${fileStamp(new Date())}.sh`,
    )
  }

  private clear(): void {
    clearActions()
    this.rows.clear()
    this.listEl.replaceChildren()
    this.paint()
  }
}
