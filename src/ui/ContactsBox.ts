/**
 * The breadcrumb's *contacts* box (§6.5): the total every map of the tab is
 * drawn to.
 *
 * Empty, it shows a pale `e.g. 10M`, gone the moment the box is clicked, and
 * every file is read as stored; the map's own total — the number `cooler info`
 * prints as `sum` — is in its tooltip. A number typed into it (`10M`,
 * `23,000,000`) draws each map to that many contacts on its own: subsampled
 * where the map holds more, oversampled through Boost-HiC where it holds fewer.
 * Every picture and every task then reads the drawn maps.
 *
 * With two maps or more on screen — a deck, or a second file in the lower
 * triangle — two chevrons follow it, which type the number for the reader:
 * **down** draws every map to the shallowest one's total, **up** to the
 * deepest's. Matching depth is the whole reason to draw a map to another total,
 * and those are the two totals a comparison is matched at.
 *
 * One element for the life of the file, which the breadcrumb re-seats on every
 * render rather than rebuilding: the trail is redrawn on every pan, and a box
 * rebuilt under a reader's cursor loses what they were typing.
 */

import { contactsText, parseContacts } from '../contacts'
import { el } from './dom'
import { iconButton, setPressed } from './icons'

/** One map on screen, and the contacts it holds as stored. */
export interface MapTotal {
  label: string
  /** `null` where the file does not say and no census has counted it. */
  total: number | null
}

export interface ContactsBoxProps {
  /** The total in force, or `null` for every file as stored. */
  value(): number | null
  /** The contacts of the map the trail describes — said in the tooltip. */
  own(): number | null
  /** Every map on screen; two or more put the chevrons up. */
  maps(): readonly MapTotal[]
  /** Why a map could not be drawn to the total, where one could not. */
  refusal(): string | null
  /** Draw every map to `contacts`, or back to the files as stored (`null`). */
  onCommit(contacts: number | null): void
}

export class ContactsBox {
  readonly el: HTMLElement
  private readonly input: HTMLInputElement
  private readonly down: HTMLButtonElement
  private readonly up: HTMLButtonElement
  /** What the reader typed that is not a number of contacts, until they fix it. */
  private typed: string | null = null

  constructor(private readonly props: ContactsBoxProps) {
    this.input = el('input', {
      class: 'input contacts-input',
      type: 'text',
      attrs: {
        inputmode: 'numeric',
        autocomplete: 'off',
        spellcheck: 'false',
        'aria-label': 'contacts',
      },
    }) as HTMLInputElement
    this.input.addEventListener('focus', () => this.input.select())
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        this.commit()
      } else if (event.key === 'Escape') {
        // Back to what is in force, as every other box in the app takes it.
        event.preventDefault()
        this.typed = null
        this.sync(true)
        this.input.blur()
      }
    })
    // On `change`, not `input`: a draw is a census and a redraw of every map,
    // and `1`, `10`, `10M` on the way to the number wanted are not requests.
    this.input.addEventListener('change', () => this.commit())
    this.down = iconButton('chevron-down', 'Subsample every map to the shallowest', () => this.match('down'), {
      class: 'btn btn-icon btn-toggle contacts-match',
      size: 14,
      pressed: false,
    })
    this.up = iconButton('chevron-up', 'Oversample every map to the deepest', () => this.match('up'), {
      class: 'btn btn-icon btn-toggle contacts-match',
      size: 14,
      pressed: false,
    })
    this.el = el(
      'div',
      { class: 'crumb-contacts' },
      el('span', { class: 'res-label', text: 'contacts' }),
      this.input,
      this.down,
      this.up,
    )
    this.sync()
  }

  /** Read the box: a number draws every map to it, empty puts the files back. */
  private commit(): void {
    const parsed = parseContacts(this.input.value)
    if (parsed !== null && typeof parsed === 'object') {
      this.typed = parsed.refused
      this.sync()
      return
    }
    this.typed = null
    if (parsed === this.props.value()) {
      this.sync(true)
      return
    }
    this.props.onCommit(parsed)
    this.sync(true)
  }

  /** The shallowest or the deepest map's total, typed for the reader. */
  private match(which: 'down' | 'up'): void {
    const totals = this.knownTotals()
    if (totals === null) return
    const target = which === 'down' ? Math.min(...totals) : Math.max(...totals)
    this.typed = null
    if (target !== this.props.value()) this.props.onCommit(target)
    this.sync(true)
  }

  /** Every map's total, or `null` while any of them is not known. */
  private knownTotals(): number[] | null {
    const maps = this.props.maps()
    if (maps.length < 2) return null
    const totals: number[] = []
    for (const map of maps) {
      if (map.total === null) return null
      totals.push(map.total)
    }
    return totals
  }

  /**
   * Re-read everything from the session. The text is left alone while the
   * reader is typing in it, unless `force` says they are done.
   */
  sync(force = false): void {
    const value = this.props.value()
    const own = this.props.own()
    this.input.placeholder = 'e.g. 10M'
    if (force || document.activeElement !== this.input) {
      if (this.typed === null) this.input.value = value === null ? '' : contactsText(value)
    }
    const maps = this.props.maps()
    const refusal = this.typed ?? this.props.refusal()
    this.input.classList.toggle('is-refused', refusal !== null)
    this.input.classList.toggle('is-set', value !== null)
    this.input.title = refusal ?? this.explain(value, own, maps)

    const deck = maps.length >= 2
    this.down.classList.toggle('hidden', !deck)
    this.up.classList.toggle('hidden', !deck)
    if (!deck) return
    const totals = this.knownTotals()
    const unknown = maps.find((map) => map.total === null)
    const least = totals === null ? null : Math.min(...totals)
    const most = totals === null ? null : Math.max(...totals)
    const lowest = maps.find((map) => map.total === least)
    const highest = maps.find((map) => map.total === most)
    this.down.disabled = totals === null
    this.up.disabled = totals === null
    this.down.title =
      totals === null
        ? `${unknown?.label ?? 'A map'} does not say how many contacts it holds yet.`
        : `Subsample every map to the shallowest: ${contactsText(least!)} contacts, ` +
          `${lowest?.label ?? 'one map'}’s own.`
    this.up.title =
      totals === null
        ? this.down.title
        : `Oversample every map to the deepest: ${contactsText(most!)} contacts, ` +
          `${highest?.label ?? 'one map'}’s own — through Boost-HiC, for each map that holds fewer.`
    this.down.setAttribute('aria-label', this.down.title)
    this.up.setAttribute('aria-label', this.up.title)
    setPressed(this.down, value !== null && value === least)
    setPressed(this.up, value !== null && value === most && most !== least)
  }

  /** The box's tooltip: what the number is, and what typing one does. */
  private explain(value: number | null, own: number | null, maps: readonly MapTotal[]): string {
    const each =
      maps.length >= 2
        ? ' ' +
          maps
            .map((map) => `${map.label}: ${map.total === null ? 'not stated' : contactsText(map.total)}`)
            .join('; ') +
          '.'
        : ''
    if (value === null) {
      return (
        `${own === null ? 'This map does not say how many contacts it holds' : `${contactsText(own)} contacts in this map`}` +
        `, as stored.${each} Type a total — 10M, 23,000,000 — to draw every map to it: subsampled ` +
        'where a map holds more (cooltools random-sample --exact), oversampled through Boost-HiC ' +
        'where it holds fewer. Every task reads the drawn maps.'
      )
    }
    return (
      `Every map drawn to ${contactsText(value)} contacts.${each} Empty the box for the files as stored.`
    )
  }
}
