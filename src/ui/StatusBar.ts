/**
 * The footer status bar: what has been read, and whether the file checks out.
 *
 * Both numbers used to be blocks in the info sidebar, which gave permanent
 * vertical space to things you glance at rather than read. They are instrumentation
 * (spec §12) and a health indicator (§6.3), so they belong where a status bar
 * belongs: one line, always visible, expanding only when asked.
 *
 * The privacy statement stays here permanently, because the dismissable notice
 * on the picker is a *reminder* and this is the standing disclosure.
 */

import { icon } from './icons'
import { isCancellation, type Cancellable, type ReaderClient } from '../worker/client'
import type { DeepValidation, StatsResult } from '../worker/protocol'
import { el, fmt } from './dom'
import { subscribeReadout } from './readout'

export interface StatusBarProps {
  /**
   * The reader whose counters are on the bar right now, or `null` for none.
   *
   * A function rather than a client, because there is one status bar and one
   * reader *per open session*: the numbers on the bar are the active tab's, and
   * they change when the tab does. `null` is a session that has not opened
   * anything — the bar then has nothing to count and says so.
   */
  client(): ReaderClient | null
}

export class StatusBar {
  readonly el: HTMLElement

  private readonly readsSummary: HTMLElement
  private readonly readsDetail: HTMLElement
  private readonly validationLabel: HTMLElement
  private readonly validationDetail: HTMLElement
  private readonly validationItem: HTMLElement
  private readonly coordinates: HTMLElement
  /** The reader the numbers on screen belong to, so a tab switch is noticed. */
  private reader: ReaderClient | null = null
  private readonly unsubscribeReadout: () => void
  /** The running deep validation, if any; clicking again stops it. */
  private validation: Cancellable<DeepValidation> | null = null

  constructor(private readonly props: StatusBarProps) {
    this.readsSummary = el('span', { class: 'status-value', text: '—' })
    this.readsDetail = el('div', { class: 'status-pop kv' })

    this.validationLabel = el('span', { class: 'status-value', text: 'not run' })
    this.validationDetail = el('div', { class: 'status-pop' })
    this.validationItem = el(
      'button',
      {
        class: 'status-item status-action',
        type: 'button',
        title:
          'Light checks ran at open. Click to run the deep scan — every pixel, ' +
          'exactly as `metacooler check --deep` does. Cheap locally, expensive over the network.',
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

    this.el = el(
      'footer',
      { class: 'app-foot' },
      // The standing disclosure, and it was missing. This module's own doc has
      // asserted since it was written that "the privacy statement stays here
      // permanently", and the picker's dismiss button promises in a tooltip
      // that "the footer keeps the same statement" -- while this element
      // rendered no such thing. So dismissing the notice made the claim
      // disappear from the application entirely, in the shipping web build,
      // which is the one place a privacy claim must not be a paraphrase of
      // something that used to be there.
      //
      // First child, so it reads before the instruments and survives the bar
      // being crowded from the right.
      el('span', { class: 'status-privacy', text: 'read in place · nothing is sent' }),
      this.coordinates,
      el(
        'div',
        { class: 'status-item status-right' },
        el('span', { class: 'status-key', text: 'read' }),
        this.readsSummary,
        this.readsDetail,
      ),
      this.validationItem,
    )
  }

  /** Release the readout subscription. */
  destroy(): void {
    this.unsubscribeReadout()
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
    this.validationLabel.textContent = 'not run'
    this.validationDetail.replaceChildren(
      el('p', {
        class: 'hint',
        text: 'Light checks ran at open: attributes, group presence, table lengths, the /chroms soft link.',
      }),
    )
  }

  private renderStats(stats: StatsResult): void {
    this.readsSummary.textContent =
      `${fmt.bytes(stats.total.bytes)} in ${fmt.int(stats.total.requests)} ` +
      `request${stats.total.requests === 1 ? '' : 's'}`
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
    this.validationLabel.textContent = 'scanning…'
    this.validationItem.classList.remove('ok', 'bad')
    const task = client.cancellable<'validateDeep'>(
      { kind: 'validateDeep' },
      (done, total) => {
        this.validationLabel.textContent =
          total === 0 ? 'scanning…' : `${Math.round((done / total) * 100)}% · click to stop`
      },
    )
    this.validation = task
    try {
      const result = await task.promise
      this.validation = null
      if (result.ok) this.validationLabel.replaceChildren(icon('check', { size: 14 }))
      else this.validationLabel.textContent = `${result.problems.length} problem(s)`
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
