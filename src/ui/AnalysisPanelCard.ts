/**
 * The Analysis column: one row per task, and nothing a task is *configured*
 * with.
 *
 * §18.1 asks for a list and gives the reason in one line — a column that both
 * lists twenty tasks and configures them is a column that does neither — so
 * everything a reader *does* to a task happens in `AnalysisDrawer` and
 * everything they can *learn* about one happens here. The split is what keeps
 * this file short enough to stay honest as the catalogue grows to sixteen.
 *
 * The one thing this list carries that a list of controls would not is the
 * running state, and it is not decoration. A job outlives the view that started
 * it (§18.3): press Run, fold the drawer away, pan somewhere else, and a scan is
 * still going with nothing on screen to say so. A reader who cannot see it is a
 * reader who starts it again — which is two scans over one byte source, the
 * exact thing `AnalysisRunner`'s queue exists to prevent. So the chip is on the
 * row, the stop button is on the row, and the drawer is only where the numbers
 * are.
 *
 * Rows are built once per task list and thereafter *updated* rather than
 * rebuilt. The runner reports progress at ten hertz, and replacing this
 * column's DOM at that rate would take the focus off whichever row a keyboard
 * reader had reached, ten times a second, for the whole length of the scan.
 */

import { TASK_GROUP_LABELS, tasksFor } from '../analysis/registry'
import type { AnalysisRunner, JobState } from '../analysis/runner'
import type { AnalysisContext, AnalysisTask, TaskGroup } from '../analysis/types'
import { el, fmt } from './dom'
import { iconButton } from './icons'

export interface AnalysisPanelOptions {
  runner: AnalysisRunner
  /** Read at every repaint: the open file changes under this column. */
  context(): AnalysisContext | null
  onOpen(task: AnalysisTask): void
  /** The id of the task whose drawer is up, so one row can be marked. */
  active(): string | null
}

/**
 * How long a run took, in the largest unit that still says something.
 *
 * Milliseconds below a second, because the difference between 40 ms and 900 ms
 * is the difference between free and noticeable; one decimal of a second up to
 * a minute; minutes and seconds past that, since `112.4 s` is a number a reader
 * has to divide. Exported because the drawer prints the same fact under the
 * result and a second spelling of it would make the two look like two different
 * measurements.
 */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`
}

/** What the chip says, and how loudly. */
interface Chip {
  text: string
  /** The tone class on `.analysis-chip`; `''` is the resting grey. */
  tone: '' | 'is-running' | 'is-done' | 'is-failed'
  /** The turning ring. Indeterminate on purpose — see the stylesheet. */
  spinner: boolean
  /**
   * A sentence that replaces the blurb: which step is running, or why it failed.
   *
   * In place of the blurb rather than beside it, because the blurb describes
   * what the task *is* and a reader looking at a failed row has stopped asking
   * that question.
   */
  detail: string
}

function chipFor(state: JobState): Chip {
  switch (state.status) {
    case 'idle':
      return { text: 'never run', tone: '', spinner: false, detail: '' }
    case 'queued':
      // Queued rather than running, and said so: one job at a time is the
      // runner's contract (§18.3), and a row that claimed to be running while it
      // waited would make the queue look like a stall.
      return { text: 'queued', tone: 'is-running', spinner: false, detail: '' }
    case 'running':
      return {
        // Clamped, as the drawer's bar is: a worker reporting more done than
        // there is to do is a bug in that task, and `120%` on a chip reads as a
        // bug in the panel.
        text: state.total > 0 ? fmt.pct(Math.min(1, state.done / state.total), 0) : 'running',
        tone: 'is-running',
        spinner: true,
        detail: state.note,
      }
    case 'done':
      return { text: `done in ${durationText(state.ms)}`, tone: 'is-done', spinner: false, detail: '' }
    case 'failed':
      return { text: 'failed', tone: 'is-failed', spinner: false, detail: state.message }
    case 'cancelled':
      // Not a failure and not drawn as one. The reader pressed Stop; they know
      // what happened, which is the distinction `JobState` is careful to keep.
      return { text: 'cancelled', tone: '', spinner: false, detail: '' }
  }
}

/** Whether there is something for a Stop button to stop. */
function stoppable(state: JobState): boolean {
  return state.status === 'running' || state.status === 'queued'
}

/** One task's row, held so a state change repaints three nodes rather than all. */
interface Row {
  task: AnalysisTask
  el: HTMLElement
  chip: HTMLElement
  blurb: HTMLElement
  /**
   * What the task is waiting for, when it cannot run yet.
   *
   * A sibling of {@link Row.el} in the list, not a child of it — so it is held
   * here rather than found through the row.
   */
  needs: HTMLElement
  stop: HTMLButtonElement
  /** The cell the chip and the stop share, so the stop can come and go. */
  cell: HTMLElement
}

export class AnalysisPanelCard {
  /** The list, to be parented into the Analysis column's body. */
  readonly el: HTMLElement

  private readonly unsubscribe: () => void
  private readonly rows: Row[] = []
  /**
   * The task list the rows were built from, joined; `null` before the first one.
   *
   * Compared rather than deep-diffed: `tasksFor` answers in registry order, so
   * two calls that agree id for id agree entirely, and this is the cheapest
   * thing that can be asked ten times a second. `null` rather than `''`, because
   * the empty list is a real answer — a file with nothing to analyse — and it
   * has an empty state of its own to draw.
   */
  private built: string | null = null

  constructor(private readonly options: AnalysisPanelOptions) {
    // No card frame and no heading. The column already has both — see the
    // stylesheet's own note above `.analysis-group` — and a card called
    // something inside a panel called Analysis would be a second name for one
    // list.
    this.el = el('div', { class: 'analysis-tasks' })
    this.unsubscribe = options.runner.subscribe(() => this.refresh())
    this.refresh()
  }

  /**
   * Bring the list up to date with the file and with the runner.
   *
   * Both at once, deliberately: the two things a row shows — whether the task
   * applies and where its job stands — change independently, and a caller
   * should not have to know which of them moved.
   */
  refresh(): void {
    const context = this.options.context()
    const tasks = context === null ? [] : tasksFor(context)
    const key = tasks.map((task) => task.id).join('\n')
    if (key !== this.built) {
      this.built = key
      this.rebuild(tasks)
    }
    this.paint()
  }

  destroy(): void {
    this.unsubscribe()
    this.rows.length = 0
    this.el.remove()
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  /**
   * The headings, in the order the tasks themselves put them in.
   *
   * Not `Object.keys(TASK_GROUP_LABELS)`: registry order is the catalogue order
   * of §18.8 and is an argued reading order, so the groups appear in the order
   * their first task does. `ParamForm.sections` orders its headings by the same
   * rule and for the same reason — the file is the document.
   */
  private groups(tasks: readonly AnalysisTask[]): TaskGroup[] {
    const out: TaskGroup[] = []
    for (const task of tasks) if (!out.includes(task.group)) out.push(task.group)
    return out
  }

  private rebuild(tasks: readonly AnalysisTask[]): void {
    this.rows.length = 0
    if (tasks.length === 0) {
      this.el.replaceChildren(
        el('p', {
          class: 'analysis-empty',
          text:
            'This file offers no analyses. A task that could never mean anything here is absent ' +
            'rather than greyed — a metagenome task on a plain cooler, say. Everything that is ' +
            'one file away is listed, waiting, with a line saying what to load.',
        }),
      )
      return
    }
    const nodes: HTMLElement[] = []
    for (const group of this.groups(tasks)) {
      nodes.push(el('h3', { class: 'analysis-group', text: TASK_GROUP_LABELS[group] }))
      for (const task of tasks.filter((item) => item.group === group)) {
        const row = this.row(task)
        this.rows.push(row)
        // Two nodes per task, the second usually hidden. Flat siblings rather
        // than a wrapper each, so `.analysis-group + .analysis-row` still names
        // the first row under a heading — and so the row keeps being the thing
        // with the border, which is what the reader is clicking.
        nodes.push(row.el, row.needs)
      }
    }
    this.el.replaceChildren(...nodes)
  }

  /**
   * One row: the title, the blurb, the state, and — while it is running — a stop.
   *
   * A `<div role="button">` rather than a `<button>`, which is the one place
   * this file departs from what the stylesheet's own comment describes. A row
   * that can be stopped carries a control of its own, and a control inside a
   * control is neither valid HTML nor reachable by a keyboard: the outer button
   * would swallow the inner one's place in the tab order. The role, the tab stop
   * and the Enter/Space handling below are what that comment was actually asking
   * for, and they are the same three things `CompareCard`'s drop zones already
   * use for the same reason.
   */
  private row(task: AnalysisTask): Row {
    const chip = el('span', { class: 'analysis-chip' })
    const stop = iconButton(
      'circle-stop',
      `Stop ${task.title}. The worker checks between chunks, so it stops at the next one.`,
      () => this.options.runner.cancel(task.id),
      { class: 'btn btn-icon', size: 14 },
    )
    // The row is the thing that opens the drawer, so a press on the stop must
    // not also be a press on the row: cancelling a job and then being shown its
    // parameters is two answers to one gesture.
    stop.addEventListener('click', (event) => event.stopPropagation())

    const cell = el('div', { class: 'plot-icon-row' }, chip)
    const blurb = el('span', { class: 'analysis-row-blurb', text: task.blurb })
    // What the task is waiting for. A **sibling** of the row rather than a third
    // line inside it: inside, it read as one more thing the task claims about
    // itself, and a reader scanning twenty rows for one they can run had to read
    // each card to the bottom. Out here it is an aside in the margin — see the
    // stylesheet, which is where the rest of that argument lives. Mounted by
    // {@link rebuild}, and empty and hidden on a row that can run, so a ready
    // panel is exactly as dense as it was.
    const needs = el('p', { class: 'analysis-row-needs hidden' })
    const node = el(
      'div',
      {
        class: 'analysis-row',
        attrs: { role: 'button', tabindex: '0' },
      },
      el('span', { class: 'analysis-row-title', text: task.title }),
      cell,
      blurb,
    )
    const open = (): void => {
      // A waiting row is a label, not a button. Opening the drawer on it would
      // show a form whose inputs cannot be filled and a Run that refuses — which
      // is the *disabled promise* §18.1 objects to, arriving one click later.
      if (node.classList.contains('is-waiting')) return
      this.options.onOpen(task)
    }
    node.addEventListener('click', open)
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      // Space scrolls the column otherwise, which moves the row out from under
      // the reader at the moment they chose it.
      event.preventDefault()
      open()
    })
    return { task, el: node, chip, blurb, needs, stop, cell }
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  private paint(): void {
    const active = this.options.active()
    const context = this.options.context()
    for (const row of this.rows) {
      const available =
        context === null ? { state: 'waiting' as const, needs: 'Open a file.' } : row.task.availability(context)
      const waiting = available.state === 'waiting'
      row.el.classList.toggle('is-waiting', waiting)
      // Off the tab order as well as off the pointer: a row nobody can act on
      // that still takes a Tab stop is a row every keyboard reader pages past.
      if (waiting) row.el.setAttribute('aria-disabled', 'true')
      else row.el.removeAttribute('aria-disabled')
      row.el.tabIndex = waiting ? -1 : 0
      row.needs.textContent = waiting ? available.needs : ''
      row.needs.classList.toggle('hidden', !waiting)

      const state = this.options.runner.stateOf(row.task.id)
      const chip = chipFor(state)

      row.chip.className = chip.tone === '' ? 'analysis-chip' : `analysis-chip ${chip.tone}`
      row.chip.replaceChildren(
        ...(chip.spinner ? [el('span', { class: 'analysis-spinner' })] : []),
        chip.text,
      )

      // The blurb slot carries the failure or the running step when there is
      // one. Plain, and not `.inline-error`: that class paints a box, and a
      // column of five rows with a red box in one of them reads as an alarm
      // rather than as a job that stopped. The chip is already red.
      row.blurb.textContent = chip.detail === '' ? row.task.blurb : chip.detail
      row.el.title = chip.detail

      const stop = stoppable(state)
      if (stop && row.stop.parentNode === null) row.cell.appendChild(row.stop)
      else if (!stop && row.stop.parentNode !== null) row.stop.remove()

      const open = active === row.task.id
      row.el.classList.toggle('is-active', open)
      // `aria-current` rather than `aria-pressed`: the row is not a switch, and
      // what "active" means here is *this is the one on screen*.
      if (open) row.el.setAttribute('aria-current', 'true')
      else row.el.removeAttribute('aria-current')
    }
  }
}
