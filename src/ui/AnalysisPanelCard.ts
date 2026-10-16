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
 * Above the cards, a box that narrows them to the tasks a reader names — by
 * title, by what the task is for, or by another name for it (*TAD*, *pileup*,
 * *A/B*: the descriptor's `keywords`) — because thirty tasks in four cards is a
 * list read top to bottom by someone who already knows the one they want.
 *
 * Rows are built once per task list and thereafter *updated* rather than
 * rebuilt. The runner reports progress at ten hertz, and replacing this
 * column's DOM at that rate would take the focus off whichever row a keyboard
 * reader had reached, ten times a second, for the whole length of the scan.
 */

import { TASK_GROUP_LABELS, tasksFor } from '../analysis/registry'
import { devFeature } from '../state/devFeatures'
import type { AnalysisRunner, JobState } from '../analysis/runner'
import type { AnalysisContext, AnalysisTask, TaskGroup } from '../analysis/types'
import { el, fmt } from './dom'
import { cardTitle, iconButton, type IconName } from './icons'
import { durationText } from '../units'

/** Re-exported: the text moved to `src/units.ts`, and this is where callers found it. */
export { durationText }

/**
 * The mark on each card's heading.
 *
 * Borrowed rather than invented: `grid-2x2` is what the Contact maps card
 * wears and `box` is what the Structures card wears, so a reader who has met
 * either already knows which picture the card is about. The 1D card takes the
 * line a track is drawn as.
 */
const TASK_GROUP_ICONS: Record<TaskGroup, IconName> = {
  '2d': 'grid-2x2',
  '3d': 'box',
  '1d': 'chart-line',
  metagenome: 'library',
};

export interface AnalysisPanelOptions {
  runner: AnalysisRunner
  /** Read at every repaint: the open file changes under this column. */
  context(): AnalysisContext | null
  onOpen(task: AnalysisTask): void
  /** The id of the task whose drawer is up, so one row can be marked. */
  active(): string | null
  /**
   * Why no task can run at all, or `null` (§18.1) — a deck with no map
   * starred. Every row is greyed with it and the sentence stands once, above
   * the cards, rather than under each of twenty rows.
   */
  blocked?(): string | null
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
  /**
   * How far through a batch this is — `2 of 5` — or `''` for an ordinary run.
   *
   * Its own pill beside the percentage rather than the first clause of the
   * sentence below, because it answers a different question and the two are read
   * at different moments. The percentage is *this map's* progress and reaches
   * 100 once per map; without a count beside it, a reader watching the fourth of
   * five fill and reset has no way to tell a batch from a stall. Which map it is
   * stays in the detail line, where there is room for a file name.
   */
  batch: string
}

function chipFor(state: JobState): Chip {
  switch (state.status) {
    case 'idle':
      return { text: 'never run', tone: '', spinner: false, detail: '', batch: '' }
    case 'queued':
      // Queued rather than running, and said so: one job at a time is the
      // runner's contract (§18.3), and a row that claimed to be running while it
      // waited would make the queue look like a stall.
      return { text: 'queued', tone: 'is-running', spinner: false, detail: '', batch: '' }
    case 'running':
      return {
        // Clamped, as the drawer's bar is: a worker reporting more done than
        // there is to do is a bug in that task, and `120%` on a chip reads as a
        // bug in the panel.
        text: state.total > 0 ? fmt.pct(Math.min(1, state.done / state.total), 0) : 'running',
        tone: 'is-running',
        spinner: true,
        batch: state.batch === undefined ? '' : `${state.batch.at + 1} of ${state.batch.of}`,
        // Which map, in words, while a batch is being worked through. The count
        // is the pill above; this is the name, which is the thing that needs
        // room and the thing a reader looks for once they know there is a batch.
        detail:
          state.batch === undefined
            ? state.note
            : `${state.batch.label}${state.note === '' ? '' : ` — ${state.note}`}`,
      }
    case 'done':
      return {
        text: `done in ${durationText(state.ms)}`,
        tone: 'is-done',
        spinner: false,
        detail: '',
        batch: '',
      }
    case 'failed':
      return { text: 'failed', tone: 'is-failed', spinner: false, detail: state.message, batch: '' }
    case 'cancelled':
      // Not a failure and not drawn as one. The reader pressed Stop; they know
      // what happened, which is the distinction `JobState` is careful to keep.
      return { text: 'cancelled', tone: '', spinner: false, detail: '', batch: '' }
  }
}

/** Whether there is something for a Stop button to stop. */
function stoppable(state: JobState): boolean {
  return state.status === 'running' || state.status === 'queued'
}

/**
 * What pressing stop does, in the two ways it can be true.
 *
 * Exported because there are **two** stop controls for one job — this column's
 * icon on the row and the drawer's `cancel` beside Run — and they were telling
 * a reader two different things about the same press. A task in the analysis
 * worker is genuinely cooperative: it reads the cancelled set between chunks and
 * abandons the work. A task in the annotations worker reads the same kind of set,
 * but only sees it when its thread is handed back — at a read of a track, or
 * where a runner yields on purpose, as a genome-wide peak call does between its
 * windows. A task with neither in it — a motif scan is one synchronous pass over
 * the residues — runs to its end, and pressing stop discards the answer rather
 * than preventing it. That is still worth doing — the row ends *cancelled*,
 * nothing is cached and no lane is adopted — and it is not what "stops at the
 * next chunk" describes, so the sentence says both. Such passes are bounded by
 * what the worker will hold (a reference over `FASTA_BYTE_CAP` is refused at
 * load), so the wait is seconds.
 */
export function stopPromise(venue: AnalysisTask['venue']): string {
  return venue === 'annotations'
    ? 'It stops at its next read; a pass with no read in it runs on, and its answer is discarded.'
    : 'The worker checks between chunks, so it stops at the next one.'
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
  /** `2 of 5`, beside the percentage; hidden outside a batch. */
  batch: HTMLElement
  /** The cell the chip and the stop share, so the stop can come and go. */
  cell: HTMLElement
  /** Which heading this row sits under, for the shared waiting line. */
  group: TaskGroup
}

/**
 * One heading, and the line its rows share when they all wait on one thing.
 *
 * The line exists because §18.1's *a greyed row carries a sentence saying what
 * to load* is right about the sentence and says nothing about how many times to
 * print it. Ten of the sixteen tasks read the matrix, so a 1D-browser session
 * drew ten rows under ON THE MAP each carrying the identical *Open a contact
 * map.* — a column twice as tall as its content, in which the one gate that
 * differed (APA's loop set) was the hardest line to find. When every waiting row
 * of a group says the same thing it is said once, here; when they differ, each
 * row keeps its own.
 */
interface Group {
  group: TaskGroup
  needs: HTMLElement
}

export class AnalysisPanelCard {
  /** The list, to be parented into the Analysis column's body. */
  readonly el: HTMLElement

  private readonly unsubscribe: () => void
  /** The sentence above the cards while every task is greyed; see {@link AnalysisPanelOptions.blocked}. */
  private readonly blockedEl = el('p', { class: 'inline-error analysis-blocked hidden', attrs: { role: 'status' } })
  /** The cards, under {@link blockedEl}. */
  private readonly cardsEl = el('div', { class: 'analysis-cards' })
  /**
   * The box that narrows the list (§18.1), between the sentence and the cards;
   * built once, so a rebuild of the cards under it keeps the caret.
   */
  private readonly filterEl = el('input', {
    class: 'input input-tiny analysis-filter',
    type: 'search',
    attrs: { 'aria-label': 'filter the tasks', spellcheck: 'false', autocomplete: 'off' },
  })
  /** Said where the box has narrowed the list to nothing. */
  private readonly noMatchEl = el('p', { class: 'analysis-empty analysis-no-match hidden', attrs: { role: 'status' } })
  private readonly rows: Row[] = []
  private readonly groupNotes: Group[] = []
  /** Each group's card, so the filter can take away a card with nothing left in it. */
  private readonly cards: Array<{ group: TaskGroup; el: HTMLElement }> = []
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
    // **One card per group** (§18.8). It was one flat list under three
    // headings, which is the shape a list has when its sections are three; at
    // four, and with the dimension a reader came looking for written on each,
    // they are cards — the same frame, mark and fold every other card in every
    // other column has, so *2D tasks* folds away exactly as *Tracks* does. The
    // panel's own name is not repeated on any of them.
    this.el = el('div', { class: 'analysis-tasks' }, this.blockedEl, this.filterEl, this.noMatchEl, this.cardsEl)
    this.filterEl.addEventListener('input', () => this.applyFilter())
    this.filterEl.addEventListener('keydown', (event) => {
      // Escape empties the box before it does anything else, as a search box
      // does; Enter opens the first task left that can run.
      if (event.key === 'Escape' && this.filterEl.value !== '') {
        event.preventDefault()
        event.stopPropagation()
        this.filterEl.value = ''
        this.applyFilter()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const first = this.rows.find(
          (row) => !row.el.classList.contains('is-filtered-out') && !row.el.classList.contains('is-waiting'),
        )
        if (first !== undefined) this.options.onOpen(first.task)
      }
    })
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
   * The cards, in the order the tasks themselves put them in.
   *
   * Not `Object.keys(TASK_GROUP_LABELS)`: registry order is the catalogue order
   * of §18.8 and is an argued reading order, so the cards appear in the order
   * their first task does. `ParamForm.sections` orders its headings by the same
   * rule and for the same reason — the file is the document. It also means a
   * group whose every task is absent has no card at all, which is how the
   * Metagenome card stays away from a file that has no genomes.
   */
  private groups(tasks: readonly AnalysisTask[]): TaskGroup[] {
    const out: TaskGroup[] = []
    for (const task of tasks) if (!out.includes(task.group)) out.push(task.group)
    return out
  }

  private rebuild(tasks: readonly AnalysisTask[]): void {
    this.rows.length = 0
    this.groupNotes.length = 0
    this.cards.length = 0
    this.filterEl.placeholder = `filter ${fmt.int(tasks.length)} task${tasks.length === 1 ? '' : 's'}…`
    this.filterEl.classList.toggle('hidden', tasks.length === 0)
    if (tasks.length === 0) {
      this.noMatchEl.classList.add('hidden')
      this.cardsEl.replaceChildren(
        el('p', {
          class: 'analysis-empty',
          text:
            'This file offers no analyses. A task that could never mean anything here is absent ' +
            // The example is a dev feature's (§29), so it is given only where
            // the reader can see the thing it is an example of.
            (devFeature('metacool')
              ? 'rather than greyed — a metagenome task on a plain cooler, say. '
              : 'rather than greyed. ') +
            'Everything that is one file away is listed, waiting, with a line saying what to load.',
        }),
      )
      return
    }
    const cards: HTMLElement[] = []
    for (const group of this.groups(tasks)) {
      const nodes: HTMLElement[] = []
      // Under the heading and above the first row, hidden until {@link paint}
      // finds that every waiting row below it is waiting on the same thing.
      const needs = el('p', { class: 'analysis-group-needs hidden' })
      this.groupNotes.push({ group, needs })
      nodes.push(needs)
      for (const task of tasks.filter((item) => item.group === group)) {
        const row = this.row(task)
        this.rows.push(row)
        // Two nodes per task, the second usually hidden. Flat siblings rather
        // than a wrapper each, so the row keeps being the thing with the
        // border, which is what the reader is clicking.
        nodes.push(row.el, row.needs)
      }
      const card = el(
        'section',
        { class: 'card analysis-card' },
        cardTitle(TASK_GROUP_LABELS[group], TASK_GROUP_ICONS[group]),
        ...nodes,
      )
      this.cards.push({ group, el: card })
      cards.push(card)
    }
    this.cardsEl.replaceChildren(...cards)
    this.applyFilter()
  }

  /**
   * Narrow the list to the tasks the box names: every word typed must be found
   * in the task's title, its blurb, its other names or its card's heading.
   * The rows are hidden rather than rebuilt, so a running task's chip keeps
   * counting under a filter that has taken it away, and comes back as it is.
   */
  private applyFilter(): void {
    const words = this.filterEl.value.toLowerCase().split(/\s+/).filter((word) => word !== '')
    let shown = 0
    for (const row of this.rows) {
      const text = searchableText(row.task)
      const keep = words.every((word) => text.includes(word))
      row.el.classList.toggle('is-filtered-out', !keep)
      row.needs.classList.toggle('is-filtered-out', !keep)
      if (keep) shown++
    }
    for (const card of this.cards) {
      const any = this.rows.some((row) => row.group === card.group && !row.el.classList.contains('is-filtered-out'))
      card.el.classList.toggle('is-filtered-out', !any)
    }
    const none = words.length > 0 && shown === 0 && this.rows.length > 0
    this.noMatchEl.textContent = none ? `No task matches “${this.filterEl.value.trim()}”.` : ''
    this.noMatchEl.classList.toggle('hidden', !none)
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
    // Beside the chip and before the stop, so the row reads left to right as
    // "how far through this map, how far through the deck, and the way to stop".
    const batch = el('span', { class: 'analysis-chip analysis-batch hidden' })
    // The sentence is {@link stopPromise}'s, so this icon and the drawer's
    // `cancel` make the same promise about the same press.
    const stop = iconButton(
      'circle-stop',
      `Stop ${task.title}. ${stopPromise(task.venue)}`,
      () => this.options.runner.cancel(task.id),
      { class: 'btn btn-icon', size: 14 },
    )
    // The row is the thing that opens the drawer, so a press on the stop must
    // not also be a press on the row: cancelling a job and then being shown its
    // parameters is two answers to one gesture.
    stop.addEventListener('click', (event) => event.stopPropagation())

    const cell = el('div', { class: 'plot-icon-row' }, chip, batch)
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
    return { task, el: node, chip, blurb, needs, stop, batch, cell, group: task.group }
  }

  // -------------------------------------------------------------------------
  // Painting
  // -------------------------------------------------------------------------

  /**
   * The sentence a group says for all of its waiting rows, or `''`.
   *
   * `''` for a group with one waiting row — moving that row's own line up to the
   * heading would put it further from the row it is about for no saving — and
   * for a group whose waiting rows ask for different things, where each row's
   * line is the only place its own answer can be.
   */
  private sharedNeeds(waiting: readonly string[]): string {
    if (waiting.length < 2) return ''
    return waiting.every((needs) => needs === waiting[0]) ? waiting[0] : ''
  }

  private paint(): void {
    const active = this.options.active()
    const context = this.options.context()
    // Nothing starred, so nothing to run against: said once, above the cards,
    // and every row greyed with it in its tooltip — the per-row and per-group
    // lines would print the same sentence twenty times.
    const blocked = this.options.blocked?.() ?? null
    this.blockedEl.textContent = blocked ?? ''
    this.blockedEl.classList.toggle('hidden', blocked === null)

    // **Availability first, for every row, and kept.** The group's line is a
    // fact about the rows under it, so it cannot be painted until they have all
    // answered — and this runs at ten hertz while a job reports progress, so
    // asking each task twice would be asking sixteen predicates thirty-two
    // times a second for one column.
    const answers = this.rows.map((row) =>
      blocked !== null
        ? { state: 'waiting' as const, needs: blocked }
        : context === null
          ? { state: 'waiting' as const, needs: 'Open a file.' }
          : row.task.availability(context),
    )
    const waitingIn = new Map<TaskGroup, string[]>()
    this.rows.forEach((row, at) => {
      const available = answers[at]
      if (available.state !== 'waiting') return
      const held = waitingIn.get(row.group) ?? []
      held.push(available.needs)
      waitingIn.set(row.group, held)
    })
    const shared = new Map<TaskGroup, string>()
    for (const [group, needs] of waitingIn) shared.set(group, this.sharedNeeds(needs))
    for (const note of this.groupNotes) {
      const text = blocked !== null ? '' : (shared.get(note.group) ?? '')
      note.needs.textContent = text
      note.needs.classList.toggle('hidden', text === '')
    }

    for (const [at, row] of this.rows.entries()) {
      const available = answers[at]
      const waiting = available.state === 'waiting'
      row.el.classList.toggle('is-waiting', waiting)
      // Off the tab order as well as off the pointer: a row nobody can act on
      // that still takes a Tab stop is a row every keyboard reader pages past.
      if (waiting) row.el.setAttribute('aria-disabled', 'true')
      else row.el.removeAttribute('aria-disabled')
      row.el.tabIndex = waiting ? -1 : 0
      // Nothing under the row where the heading above it already says it.
      const own =
        waiting && blocked === null && available.needs !== shared.get(row.group) ? available.needs : ''
      row.needs.textContent = own
      row.needs.classList.toggle('hidden', own === '')

      const state = this.options.runner.stateOf(row.task.id)
      const chip = chipFor(state)

      row.chip.className = chip.tone === '' ? 'analysis-chip' : `analysis-chip ${chip.tone}`
      row.chip.replaceChildren(
        ...(chip.spinner
          ? [el('span', { class: 'analysis-spinner', attrs: { 'aria-hidden': 'true' } })]
          : []),
        chip.text,
      )
      row.batch.textContent = chip.batch
      row.batch.classList.toggle('hidden', chip.batch === '')

      // The blurb slot carries the failure or the running step when there is
      // one. Plain, and not `.inline-error`: that class paints a box, and a
      // column of five rows with a red box in one of them reads as an alarm
      // rather than as a job that stopped. The chip is already red.
      row.blurb.textContent = chip.detail === '' ? row.task.blurb : chip.detail
      // A greyed row carries its reason in its own tooltip whether or not the
      // sentence is printed under it, so a reader pointing at the seventh row of
      // a waiting group is answered where they are pointing.
      row.el.title = waiting ? available.needs : chip.detail

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

/** Everything the list's filter reads a task by, lowercased once per call. */
function searchableText(task: AnalysisTask): string {
  return [task.title, task.blurb, ...(task.keywords ?? []), TASK_GROUP_LABELS[task.group], task.id]
    .join(' \n ')
    .toLowerCase()
}
