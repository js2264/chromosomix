/**
 * The footer status bar: what has been read, and whether the file checks out.
 *
 * Both numbers used to be blocks in the info sidebar, which gave permanent
 * vertical space to things you glance at rather than read. They are instrumentation
 * (spec §12) and a health indicator (§6.3), so they belong where a status bar
 * belongs: one line, always visible, expanding only when asked.
 *
 * One line is the constraint every value here is written to, and it is a
 * constraint about the *plot*: the bar is the bottom edge of the window the map
 * is measured against, so a second line of status is a row of pixels taken off
 * every view — and it appeared exactly when the reader hovered a stack of
 * tracks, because that is when the coordinate readout is longest. So each item
 * shows the shortest true form of its number and keeps the rest in the panel it
 * already opens on hover, and the readout is the one thing allowed to be
 * elided, because it is also the one thing that is re-said a moment later.
 */

import { icon } from './icons'
import { devFeature } from '../state/devFeatures'
import { isCancellation, type Cancellable, type ReaderClient } from '../worker/client'
import type { DeepValidation, StatsResult } from '../worker/protocol'
import { el, fmt } from './dom'
import { deviceBytes, UsageMeter } from '../perf/usage'
import { subscribeReadout } from './readout'

export interface StatusBarProps {
  /**
   * The reader whose counters are on the bar right now, or `null` for none.
   *
   * A function rather than a client, because there is one status bar and one
   * reader *per open session*: the numbers on the bar are the active tab's, and
   * they change when the tab does. `null` is a session that has not opened
   * anything, and the two items that are about a file — the byte counter and
   * the validation check — are then **absent** rather than dashed: an em dash
   * that never fills in reads as a number that failed to load, which is the
   * argument the memory item has always applied to itself, and a check button
   * that silently does nothing is what §8.5 forbids outright.
   */
  client(): ReaderClient | null
}

export class StatusBar {
  readonly el: HTMLElement

  private readonly readsSummary: HTMLElement
  private readonly readsDetail: HTMLElement
  /** The whole `read` item, held so a tab with no file can do without it. */
  private readonly readsItem: HTMLElement
  private readonly validationLabel: HTMLElement
  private readonly validationDetail: HTMLElement
  private readonly validationItem: HTMLElement
  private readonly coordinates: HTMLElement
  /** The reader the numbers on screen belong to, so a tab switch is noticed. */
  private reader: ReaderClient | null = null
  private readonly unsubscribeReadout: () => void
  /** The running deep validation, if any; clicking again stops it. */
  private validation: Cancellable<DeepValidation> | null = null

  /**
   * What this browser tab is costing the machine.
   *
   * The one thing on the bar that is not about the open file, and deliberately
   * so: it is per *tab* rather than per session, because the memory a gene model
   * holds and the core a scan is burning are shared by every session in the
   * window and there is nothing useful to say about one of them alone.
   */
  private readonly usage = new UsageMeter()
  private readonly memoryValue: HTMLElement
  private readonly memoryDetail: HTMLElement
  private readonly memoryItem: HTMLElement
  private readonly cpuValue: HTMLElement
  private readonly cpuDetail: HTMLElement
  private readonly usageTimer: ReturnType<typeof setInterval>

  constructor(private readonly props: StatusBarProps) {
    this.readsSummary = el('span', { class: 'status-value', text: '—' })
    this.readsDetail = pop('status-read-pop', 'kv')
    this.readsItem = item('read', this.readsSummary, this.readsDetail)

    this.validationLabel = el('span', { class: 'status-value', text: NEVER_RUN })
    this.validationDetail = pop('status-validation-pop')
    // **No `title`.** This was the one item on the bar carrying a native
    // tooltip, and it said something its own hover panel did not: the panel
    // that opens on the pointer described the light checks and stopped, while
    // the invitation to run the deep scan waited a second and a half behind it
    // in a second surface. Two hover surfaces on one control, disagreeing about
    // what the control does. One panel, and the offer is in it (§6.3 keeps the
    // deep scan an explicit action rather than something the bar advertises).
    this.validationItem = el(
      'button',
      {
        class: 'status-item status-action',
        type: 'button',
        attrs: { 'aria-describedby': 'status-validation-pop' },
      },
      el('span', { class: 'status-key', text: 'validation' }),
      this.validationLabel,
      this.validationDetail,
    )
    this.validationItem.addEventListener('click', () => void this.runValidation())

    // The coordinate readout leads the bar, because it changes with every
    // pointer move and is the only thing here anyone reads continuously. The
    // two instruments are pushed to the right, where a status bar keeps them.
    this.coordinates = el('span', { class: 'status-coords' })
    this.unsubscribeReadout = subscribeReadout((text) => {
      this.coordinates.textContent = text
    })

    this.memoryValue = el('span', { class: 'status-value', text: '—' })
    this.memoryDetail = pop('status-memory-pop')
    this.memoryItem = item('memory', this.memoryValue, this.memoryDetail, 'status-usage')
    this.cpuValue = el('span', { class: 'status-value', text: '—' })
    this.cpuDetail = pop('status-cpu-pop')

    this.el = el(
      'footer',
      { class: 'app-foot' },
      // No standing privacy line here any more. It said "read in place · nothing
      // is sent" on every screen of every session, which is a sentence a reader
      // finishes reading once and then has permanently in the corner of a bar
      // whose other three items are numbers that change. The claim itself is not
      // gone — the picker makes it where a file is about to be opened, and the
      // About dialog states it in full — and this is the one surface where it
      // was competing with the instruments for a line that has to stay one line.
      this.coordinates,
      this.readsItem,
      this.validationItem,
      this.memoryItem,
      item('cpu', this.cpuValue, this.cpuDetail, 'status-usage'),
    )

    // Once a second: the CPU reading is a three-second average, so faster would
    // redraw the same number, and slower would lag behind the pan that caused
    // it. Skipped outright while the tab is hidden — nobody is reading it, and
    // the numbers there describe timer throttling rather than work.
    this.usageTimer = setInterval(() => {
      if (document.visibilityState === 'visible') this.renderUsage()
    }, USAGE_TICK_MS)
    this.renderUsage()
  }

  /** Release the readout subscription and stop measuring. */
  destroy(): void {
    this.unsubscribeReadout()
    clearInterval(this.usageTimer)
    this.usage.destroy()
  }

  /**
   * Memory and CPU, redrawn.
   *
   * Text assignments rather than a rebuild, because this runs every second for
   * as long as the application is open and replacing the nodes under a tooltip
   * the reader has open would close it once a second.
   */
  private renderUsage(): void {
    const device = deviceBytes()
    const memory = this.usage.memory()
    // Hidden rather than dashed on an engine that has no answer: an em dash that
    // never fills in reads as a number that failed to load.
    this.memoryItem.classList.toggle('hidden', memory === null)
    if (memory !== null) {
      const share =
        memory.ceiling === null || memory.ceiling <= 0
          ? null
          : memory.used / memory.ceiling
      // Bytes on the bar and the share in the panel. The two together are the
      // widest item here, and the share is the half nobody is watching: what a
      // reader glances at this for is whether the tab is holding 200 MB or 6 GB,
      // and against what it is a share of — the ceiling, the device — is a
      // question they ask once, in the panel, where the answer already is.
      this.memoryValue.textContent = fmt.bytes(memory.used)
      this.memoryDetail.replaceChildren(
        el(
          'div',
          { class: 'kv' },
          ...keyValue(memory.scope === 'tab' ? 'this tab' : 'JavaScript heap', fmt.bytes(memory.used)),
          ...(memory.ceiling === null ? [] : keyValue(memory.ceilingLabel, fmt.bytes(memory.ceiling))),
          // A decimal below a tenth, because the honest answer usually is a
          // fraction of a percent — a tab is small against the memory a machine
          // has — and `0%` for everything under half of one reads as a figure
          // that never arrived rather than as a small one.
          ...(share === null
            ? []
            : keyValue('share of that', fmt.pct(share, share < 0.1 ? 1 : 0))),
          ...(device === null ? [] : keyValue('device memory, as reported', fmt.bytes(device))),
        ),
        el('p', { class: 'hint', text: MEMORY_NOTE[memory.scope] }),
      )
    }

    const cpu = this.usage.cpu()
    this.cpuValue.textContent = fmt.pct(cpu.fraction, 0)
    this.cpuDetail.replaceChildren(
      el(
        'div',
        { class: 'kv' },
        // Numbered where a label repeats: two open sessions are two readers, and
        // two rows both called "reader" read as the same one written twice.
        ...cpu.threads.flatMap((thread, index) => {
          const seen = cpu.threads.filter((other, i) => other.label === thread.label && i < index)
          const repeats = cpu.threads.filter((other) => other.label === thread.label).length > 1
          const label = repeats ? `${thread.label} ${seen.length + 1}` : thread.label
          return keyValue(label, thread.busy === null ? 'starting…' : fmt.pct(thread.busy, 0))
        }),
        ...keyValue('cores in use', `${cpu.cores.toFixed(2)} of ${fmt.int(cpu.hardware)}`),
      ),
      el('p', { class: 'hint', text: CPU_NOTE }),
    )
  }

  /**
   * Show the active session's counters, or clear them.
   *
   * Called after every view change *and* on every tab switch, because the two
   * are the same event as far as this bar is concerned: what is being counted
   * changed. Validation is per file — carrying a green tick across a switch
   * would vouch for a file that was never checked — so it resets whenever the
   * reader under the bar is not the one it last spoke to.
   */
  refresh(): void {
    const client = this.props.client()
    this.readsItem.classList.toggle('hidden', client === null)
    this.validationItem.classList.toggle('hidden', client === null)
    if (client === null) {
      this.reader = null
      this.readsSummary.textContent = '—'
      this.readsDetail.replaceChildren()
      this.clearValidation()
      return
    }
    if (client !== this.reader) {
      this.reader = client
      this.clearValidation()
    }
    void client
      .request<'stats'>({ kind: 'stats' })
      .then((stats) => {
        // A reply from the reader of a tab that is no longer on screen would
        // paint one session's numbers under another's name.
        if (this.props.client() === client) this.renderStats(stats)
      })
      .catch(() => {
        /* counters are diagnostics; never let them break a view */
      })
  }

  private clearValidation(): void {
    this.validation?.cancel()
    this.validation = null
    this.validationItem.classList.remove('ok', 'bad')
    this.validationLabel.textContent = NEVER_RUN
    this.validationDetail.replaceChildren(
      el('p', {
        class: 'hint',
        // The soft link and the command are the multi-genome format's, a dev
        // feature (§29).
        text: devFeature('metacool')
          ? 'Light checks ran at open: attributes, group presence, table lengths, the /chroms ' +
            'soft link. Click to scan every pixel, as the metacooler check --deep command does — ' +
            'cheap locally, slow over the network.'
          : 'Light checks ran at open: attributes, group presence, table lengths. Click to scan ' +
            'every pixel — cheap locally, slow over the network.',
      }),
    )
  }

  private renderStats(stats: StatsResult): void {
    // Bytes alone. The request count is the more interesting number to whoever
    // is tuning the reader and the less interesting one to everybody else, and
    // spelling it out on the bar cost a phrase — "589.0 MB in 589 requests" —
    // wide enough to wrap the item onto a second line. It is the first row of
    // the panel this item opens on hover, which is where the other four
    // counters have always been.
    this.readsSummary.textContent = fmt.bytes(stats.total.bytes)
    this.readsDetail.replaceChildren(
      ...keyValue('requests, total', fmt.int(stats.total.requests)),
      ...keyValue('bytes, total', fmt.bytes(stats.total.bytes)),
      ...keyValue('requests, last view', fmt.int(stats.lastOp.requests)),
      ...keyValue('bytes, last view', fmt.bytes(stats.lastOp.bytes)),
      ...keyValue('worker calls', fmt.int(stats.calls)),
    )
  }

  private async runValidation(): Promise<void> {
    const client = this.props.client()
    if (client === null) return
    // A cancellable, reporting run. It is the same pass over every pixel the
    // overview makes, and on a reference-scale file it is minutes long; it used
    // to be a static "scanning…" with no way out.
    if (this.validation !== null) {
      this.validation.cancel()
      this.validation = null
      this.validationLabel.textContent = 'cancelled'
      return
    }
    // §26.7's word, not a sixth of our own: a thing that can run says *running*
    // — or the percentage, once there is a total to take one against.
    this.validationLabel.textContent = 'running'
    this.validationItem.classList.remove('ok', 'bad')
    const task = client.cancellable<'validateDeep'>(
      { kind: 'validateDeep' },
      (done, total) => {
        this.validationLabel.textContent =
          total === 0 ? 'running' : `${Math.round((done / total) * 100)}% · click to stop`
      },
    )
    this.validation = task
    try {
      const result = await task.promise
      this.validation = null
      if (result.ok) this.validationLabel.replaceChildren(icon('check', { size: 14 }))
      else {
        // Spelled, not bracketed: every other count in the app resolves its own
        // plural, and `3 problem(s)` is form-letter language on a bar whose
        // other values are clean figures.
        const n = result.problems.length
        this.validationLabel.textContent = `${fmt.int(n)} problem${n === 1 ? '' : 's'}`
      }
      this.validationItem.classList.toggle('ok', result.ok)
      this.validationItem.classList.toggle('bad', !result.ok)
      this.validationDetail.replaceChildren(
        el('p', { class: result.ok ? 'ok' : 'inline-error', text: result.ok ? result.note : 'Problems found:' }),
        ...result.problems.map((problem) => el('p', { class: 'inline-error', text: problem })),
      )
      this.refresh()
    } catch (err) {
      this.validation = null
      if (isCancellation(err)) {
        this.validationLabel.textContent = 'cancelled'
        return
      }
      this.validationLabel.textContent = 'failed'
      this.validationItem.classList.add('bad')
      this.validationDetail.replaceChildren(
        el('p', { class: 'inline-error', text: err instanceof Error ? err.message : String(err) }),
      )
    }
  }
}

function keyValue(key: string, value: string): HTMLElement[] {
  return [el('div', { class: 'k', text: key }), el('div', { class: 'v', text: value })]
}

/**
 * A hover panel, named so its item can point at it.
 *
 * `role="tooltip"` and an `id`, because the rows inside are the whole of what
 * the item has to say and a reader on a screen reader was told only the
 * headline: `aria-describedby` on the item is what carries the five counters,
 * the memory ceiling and the note under them into the accessible description.
 */
function pop(id: string, extra?: string): HTMLElement {
  return el('div', {
    class: extra === undefined ? 'status-pop' : `status-pop ${extra}`,
    attrs: { role: 'tooltip', id },
  })
}

/**
 * One instrument on the bar: its word, its value, and the panel it opens.
 *
 * **Focusable**, which the three read-only ones were not: they were plain
 * `div`s, so the `:focus-visible` rule the stylesheet already writes for them
 * could never fire and the breakdown behind them — the request and byte
 * counters a reader on a metered bucket is watching — was reachable by pointer
 * only. `tabindex` rather than `<button>`: pressing them does nothing, and a
 * button that does nothing is a control that lies. The one item that *is* a
 * button builds itself, because it has a press to answer and a class that says
 * how the answer came out.
 */
function item(word: string, value: HTMLElement, detail: HTMLElement, extra = ''): HTMLElement {
  return el(
    'div',
    {
      class: extra === '' ? 'status-item' : `status-item ${extra}`,
      attrs: { tabindex: '0', 'aria-describedby': detail.id },
    },
    el('span', { class: 'status-key', text: word }),
    value,
    detail,
  )
}

/**
 * The word for a check that has not been asked for (§26.7).
 *
 * *never run*, not *not run*: the second could be read as "was refused", and
 * the Analysis panel's chips have used the first for the same state all along.
 */
const NEVER_RUN = 'never run'

/** How often the usage figures are redrawn. */
const USAGE_TICK_MS = 1000

/**
 * What the memory number covers, which depends on how it was obtained.
 *
 * Said in the tooltip rather than implied by the value, because the two
 * measurements differ by more than precision: one is the tab and one is a part
 * of it, and a reader comparing either against their operating system's task
 * manager deserves to know which they are holding.
 */
const MEMORY_NOTE: Record<'tab' | 'heap', string> = {
  tab:
    'The whole of this browser tab — this page, its workers, and the arrays and images they ' +
    'hold. Measured by the browser on request; it can lag a few seconds behind a large file ' +
    'being released.',
  heap:
    'The main thread’s JavaScript heap. It is not the tab’s whole memory: the reader and ' +
    'annotations workers have heaps of their own, and canvases, decoded images and the file ' +
    'being read are outside all of them. A browser cannot tell a page its process size — that ' +
    'figure would leak across origins — so this is the closest one available here.',
}

/**
 * What the CPU number is, which is not what a task manager measures.
 *
 * Worth spelling out: it is a floor, not an estimate that could be high. Nothing
 * it reports is work that did not happen.
 */
const CPU_NOTE =
  'No browser reports a tab’s CPU. This is measured from the inside instead: every thread in ' +
  'the tab times its own event loop, and what you see is the share of the last three seconds ' +
  'they spent unable to answer, summed and taken against this machine’s cores. Work too brief ' +
  'to delay anything does not appear, so the true figure is never lower than this one.'
