/**
 * The search box over a portal: a select, a query, a button, nothing on load.
 *
 * SPECS §23.4. It is deliberately the smallest thing that can produce a hub:
 * it draws **no rows**. A page of hits is a hub (`state/portal.ts` argues why),
 * and there is already one table in this app that draws a hub with its filters,
 * its sorting and its kind badges — so this hands the hub up through
 * `onResults` and the picker gives it to `HubTable.show`. A second table here
 * would be a second place for "what a row looks like" to be decided, and the
 * two would drift on the first column anybody added.
 *
 * ## Nothing runs until somebody asks
 *
 * No fetch on construction, none on a keystroke, none on selecting a portal.
 * §11's rule for hubs is the rule here: a reader who never types into this box
 * makes no third-party request at all, and a search *is* a third-party request
 * — it tells encodeproject.org that somebody looked, and it tells it what for.
 * That is a perfectly ordinary thing to do on purpose and not a thing to do on
 * a page load.
 *
 * ## What it says when a portal will not answer
 *
 * The whole of the failure copy lives in `state/portal.ts`, because the thing
 * that knows a refusal is CORS rather than a typo is the thing that made the
 * request. This shows that message unchanged and hands it to `onError` — one
 * wording, in the status line and in whatever the host does with it. §8.5's
 * rule for a refusal is that it names the fix; for a portal that refuses
 * browsers the fix is the generated hub already sitting in the picker, which is
 * what that message names.
 */

import { PORTALS, searchPortal, type Portal } from '../state/portal'
import { button, el } from './dom'
import type { Hub } from '../state/hub'

export interface PortalSearchProps {
  /** A page of hits, as a hub whose rows are absolute and ready for the table. */
  onResults(hub: Hub): void
  /** The portal refused, failed, or could not be reached. Already a sentence. */
  onError(message: string): void
  /** For tests; the live path uses the page's own `fetch`. */
  fetchImpl?: typeof fetch
}

export class PortalSearch {
  readonly el: HTMLElement

  private readonly select: HTMLSelectElement
  private readonly input: HTMLInputElement
  private readonly go: HTMLButtonElement
  private readonly status: HTMLElement
  /**
   * Bumped per search, so a slow answer cannot overwrite a fast one.
   *
   * The same guard `ui/folderBrowse.ts` keeps and for the same reason: two
   * searches in a row, and the first one's "nothing matched" landing on the
   * second one's rows is a status line about a search nobody is looking at.
   */
  private searching = 0

  constructor(private readonly props: PortalSearchProps) {
    this.select = el('select', {
      class: 'select portal-select',
      title: 'Which portal to ask',
    })
    for (const portal of PORTALS) {
      this.select.appendChild(el('option', { value: portal.id, text: portal.label }))
    }
    // A portal change makes the line above stale — "12 results" belongs to the
    // portal it was counted from — and clearing it is cheaper than qualifying
    // it. The table keeps what it has; the hub's own name says where it came
    // from.
    this.select.addEventListener('change', () => this.say('', false))

    this.input = el('input', {
      class: 'input portal-query',
      type: 'text',
      placeholder: 'GM12878, K562, cohesin…',
      title: 'Free text: a cell line, a lab, an accession. Empty searches for everything.',
    })
    this.input.addEventListener('keydown', (event) => {
      // Enter in a box beside a button means the button. Not doing this is the
      // single most reliable way to make a search box feel broken.
      if (event.key === 'Enter') void this.run()
    })

    this.go = button('search', () => void this.run(), { class: 'btn btn-primary' })
    this.status = el('p', { class: 'hint portal-status' })

    this.el = el(
      'div',
      { class: 'portal-search' },
      el('p', {
        class: 'hint',
        text:
          'Asks the portal itself, when you press search and not before, and puts the hits in ' +
          'the table below. The generated hubs above list the same files without asking anyone.',
      }),
      el('div', { class: 'portal-search-row' }, this.select, this.input, this.go),
      this.status,
    )
  }

  /** The portal the select is on, which is the first one until anybody moves it. */
  private get portal(): Portal {
    return PORTALS.find((portal) => portal.id === this.select.value) ?? PORTALS[0]
  }

  /**
   * Run the search that is in the box.
   *
   * Public because the host may want to trigger one — a `?portal=` link, a
   * suggestion clicked elsewhere — and because a second spelling of this is how
   * the button and the key would come to disagree.
   */
  async run(): Promise<void> {
    const portal = this.portal
    const query = this.input.value.trim()
    const token = ++this.searching
    this.say('searching…', false)
    this.go.disabled = true
    try {
      const hub = await searchPortal(portal, query, { fetchImpl: this.props.fetchImpl })
      if (token !== this.searching) return
      this.say(countOf(hub, portal), false)
      this.props.onResults(hub)
    } catch (cause) {
      if (token !== this.searching) return
      // Shown exactly as it was written. The portal adapter knows whether this
      // was a refusal, a 500 or a browser that was never allowed to read the
      // answer, and it names the alternative; rewording it here would lose the
      // half that tells the reader what to do next.
      const message = cause instanceof Error ? cause.message : String(cause)
      this.say(message, true)
      this.props.onError(message)
    } finally {
      if (token === this.searching) this.go.disabled = false
    }
  }

  /** Put the box back to how it opened — a dialog closed, a hub picked elsewhere. */
  clear(): void {
    this.searching++
    this.input.value = ''
    this.go.disabled = false
    this.say('', false)
  }

  private say(text: string, bad: boolean): void {
    this.status.textContent = text
    this.status.classList.toggle('bucket-error', bad)
  }
}

/**
 * The status line for a page of hits.
 *
 * The hub's own `description` when there were more matches than rows, because
 * that sentence already says both numbers and what to do about it; a plain
 * count when the page *is* the answer. Nothing matching is its own line: "0
 * results" is true and useless, and the two things worth saying — what a query
 * here looks like, and that an empty box is allowed — are the two things a
 * reader who typed a gene name into a file search does not know.
 */
function countOf(hub: Hub, portal: Portal): string {
  // The description first, and for the empty table too: a portal that matched
  // three hundred files of which none carries a public URL is a different thing
  // from one that matched nothing, and only that sentence can tell them apart.
  if (hub.description !== undefined) return hub.description
  const shown = hub.entries.length
  if (shown === 0) {
    return (
      `${portal.label} matched nothing. This searches released contact maps, so a cell line ` +
      '("GM12878"), a lab or an accession finds them — or search with an empty box for ' +
      'everything it has.'
    )
  }
  return `${shown} ${shown === 1 ? 'result' : 'results'}`
}
