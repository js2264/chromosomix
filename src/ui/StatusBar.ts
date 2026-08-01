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
import type { ReaderClient } from '../worker/client'
import type { StatsResult } from '../worker/protocol'
import { el, fmt } from './dom'
import { subscribeReadout } from './readout'

export interface StatusBarProps {
  client: ReaderClient
}

export class StatusBar {
  readonly el: HTMLElement

  private readonly readsSummary: HTMLElement
  private readonly readsDetail: HTMLElement
  private readonly validationLabel: HTMLElement
  private readonly validationDetail: HTMLElement
  private readonly validationItem: HTMLElement
  private readonly coordinates: HTMLElement
  private readonly unsubscribeReadout: () => void
  private hasFile = false

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
   * Reset for a newly opened file. Validation state is per-file — carrying a
   * green tick across an `open` would vouch for a file that was never checked.
   */
  reset(): void {
    this.hasFile = true
    this.validationItem.classList.remove('ok', 'bad')
    this.validationLabel.textContent = 'not run'
    this.validationDetail.replaceChildren(
      el('p', {
        class: 'hint',
        text: 'Light checks ran at open: attributes, group presence, table lengths, the /chroms soft link.',
      }),
    )
    this.refresh()
  }

  /** Poll the worker's counters; called after every view change. */
  refresh(): void {
    if (!this.hasFile) return
    void this.props.client
      .request<'stats'>({ kind: 'stats' })
      .then((stats) => this.renderStats(stats))
      .catch(() => {
        /* counters are diagnostics; never let them break a view */
      })
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
    if (!this.hasFile) return
    this.validationLabel.textContent = 'scanning…'
    this.validationItem.classList.remove('ok', 'bad')
    try {
      const result = await this.props.client.request<'validateDeep'>({ kind: 'validateDeep' })
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
