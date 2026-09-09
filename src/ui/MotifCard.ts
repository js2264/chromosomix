/**
 * The **Find a sequence** card: a motif, and the two lanes it produces.
 *
 * A reader with a reference loaded has a question this viewer could not answer
 * and every genome browser is expected to: *where is `GGTCANNNTGACC`?* It is the
 * one query whose answer is not in any file they could drop — it has to be
 * computed from the residues — and it is a question with a natural shape here,
 * because the answer is a set of intervals and this application already knows
 * how to draw, place, colour, export and measure those (§8.3, §18.3).
 *
 * ## Why it is a card and not the search box
 *
 * `ui/SearchBox.ts` looks up a locus or a feature *name*, answers instantly from
 * an index already in memory, and puts one result on screen by navigating to it.
 * A motif search is none of those things: it reads the whole genome, it takes
 * long enough to need a progress state and a failure state, and its answer is
 * thousands of places rather than one. Folding it into the box would mean a
 * control that sometimes navigates and sometimes silently makes two tracks, and
 * a reader could not tell in advance which they were about to get.
 *
 * ## Why the search runs in the annotations worker
 *
 * Because the residues are there and nowhere else. A FASTA is parsed into that
 * worker and deliberately never shipped out whole — `bases` answers a window and
 * is capped — so a main-thread search would mean either pulling a genome across
 * the boundary or issuing thirty windowed reads and stitching the seams. See the
 * `motif` request in `annotations/worker/protocol.ts`.
 *
 * ## Why two lanes come back rather than one
 *
 * `annotations/motifTrack.ts` argues it in full: a set of sites answers "where
 * exactly" and "how dense", the first is a picket fence at chromosome scale and
 * the second is a bar chart of ones at base scale, and no single lane is both.
 * Both are ordinary rows in the Tracks card the moment they exist, so a reader
 * who wants one of them deletes the other with the same × as everything else.
 *
 * ## What it does not do: survive a reload
 *
 * The rows are `derived` (`AnnotationCard`'s track-combine control is the same
 * choice for the same reason), which `StoredEntry` has no member for — so they
 * are gone on reload rather than coming back detached with a Recompute button.
 * That is deliberate rather than unfinished: the alternative is a
 * `ComputedSource`, which names an analysis task that would have to exist in the
 * registry for `SyntheticCard`'s Recompute to have anything to call, and
 * inventing a task purely to own a persistence path is a larger claim than this
 * feature is making. A search is a few seconds and the pattern is on screen; the
 * cost of re-running one is not the cost of losing a workspace.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationClient } from '../annotations/worker/client'
import type { MotifScanResult } from '../annotations/worker/protocol'
import { motifBinsize, motifDensity, motifFeatures, motifLabel } from '../annotations/motifTrack'
import { defaultStyle, placementOn } from '../annotations/types'
import type { AnnotationEntry } from '../annotations/types'
import type { Contig } from '../genome/assembly'
import { button, el, fmt } from './dom'
import { cardTitle } from './icons'

export interface MotifCardOptions {
  store: AnnotationStore
  /**
   * The worker holding the reference.
   *
   * The session's own client rather than one of this card's: the FASTA is loaded
   * into *that* worker under the entry id the store knows it by, and a private
   * client would be a second thread with no genome in it.
   */
  client: AnnotationClient
  /**
   * The assembly's sequences, asked for rather than held.
   *
   * A browser adopts real lengths when a file that knows them arrives
   * (`Session.considerLengths`), so a list captured when this card was built
   * would put the density grid on the lengths the session has since stopped
   * believing. A function is read at the moment a search runs, which is the only
   * moment the answer matters.
   */
  contigs: () => readonly Contig[]
}

/**
 * The prefix every row this card makes is named with.
 *
 * Deliberately not the `a<digits>` shape `mintAnnotationId` produces, on
 * `SyntheticCard`'s reasoning (`SYNTHETIC_PREFIX`): an id that could collide
 * with a restored file row would let a reload's bookkeeping overwrite a search
 * result, or the reverse. It also makes a re-run of the same query *replace* its
 * own rows — `AnnotationStore.begin` keeps an existing id's slot — so a reader
 * refining a pattern gets one lane that changes rather than nine lanes to tidy.
 */
const MOTIF_PREFIX = 'motif:'

/** A sequence entry that has finished loading, which is the only kind to search. */
function readySequences(store: AnnotationStore): AnnotationEntry[] {
  return store.entries.filter((entry) => entry.kind === 'sequence' && entry.status === 'ready')
}

export class MotifCard {
  readonly el: HTMLElement

  private readonly pattern: HTMLInputElement
  private readonly strands: HTMLInputElement
  private readonly picker: HTMLSelectElement
  private readonly pickerRow: HTMLElement
  private readonly go: HTMLButtonElement
  private readonly note: HTMLElement
  private readonly unsubscribe: () => void
  /** Set while a search is in flight, so a second Enter cannot start a race. */
  private busy = false

  constructor(private readonly props: MotifCardOptions) {
    this.pattern = el('input', {
      class: 'input',
      type: 'text',
      placeholder: 'GGTCANNNTGACC',
      title:
        'A sequence to find, in IUPAC. A C G T U, and the ambiguity codes ' +
        'R Y S W K M B D H V N. Spaces are ignored.',
    })
    // Enter is the gesture for a one-field form, and a reader typing a motif
    // will reach for it before they see the button.
    this.pattern.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void this.search()
      }
    })

    this.strands = el('input', { class: 'checkbox', type: 'checkbox' })
    this.strands.checked = true

    this.picker = el('select', { class: 'select' })
    this.pickerRow = el(
      'label',
      { class: 'motif-row' },
      el('span', { class: 'hint', text: 'in' }),
      this.picker,
    )

    this.go = button('find', () => void this.search(), {
      class: 'btn',
      title: 'Search the reference for this sequence',
    })

    this.note = el('p', { class: 'hint motif-note' })

    this.el = el(
      'div',
      { class: 'card motif-card' },
      cardTitle('Find a sequence', 'search'),
      this.pickerRow,
      el('div', { class: 'motif-row' }, this.pattern, this.go),
      el(
        'label',
        { class: 'motif-row hint', title: 'Also find the motif on the reverse strand' },
        this.strands,
        'both strands',
      ),
      this.note,
    )

    this.unsubscribe = props.store.subscribe(() => this.refresh())
    this.refresh()
  }

  /**
   * Show the card only while there is something to search.
   *
   * The whole feature depends on a reference being loaded and nothing else does,
   * so a card offering it over a session with no FASTA would be a control that
   * can only ever refuse. Hidden rather than disabled for that reason: a
   * disabled field invites a reader to work out what would enable it, and the
   * answer here — "drop a FASTA" — is not written anywhere near it.
   */
  refresh(): void {
    const sequences = readySequences(this.props.store)
    this.el.classList.toggle('hidden', sequences.length === 0)
    if (sequences.length === 0) return

    // Rebuilt rather than diffed: this list is one or two entries in every real
    // session, and the selection is preserved by id so a reload of the options
    // does not move a reader's choice.
    const chosen = this.picker.value
    this.picker.replaceChildren(
      ...sequences.map((entry) => el('option', { value: entry.id, text: entry.label })),
    )
    if (sequences.some((entry) => entry.id === chosen)) this.picker.value = chosen
    // One reference is not a choice, and a select with a single option is a
    // control that does nothing.
    this.pickerRow.classList.toggle('hidden', sequences.length < 2)
  }

  destroy(): void {
    this.unsubscribe()
  }

  private say(text: string, bad = false): void {
    this.note.textContent = text
    this.note.classList.toggle('warn', bad)
  }

  private async search(): Promise<void> {
    if (this.busy) return
    const entry = this.picker.value
    const pattern = this.pattern.value.trim()
    if (entry === '' || pattern === '') return

    const bothStrands = this.strands.checked
    this.busy = true
    this.go.disabled = true
    this.say('searching…')
    try {
      const result = await this.props.client.request<'motif'>({
        kind: 'motif',
        entry,
        pattern,
        bothStrands,
      })
      // A pattern nobody could compile is a fact about what was typed, not a
      // failure — it arrives as a sentence and belongs under the field.
      if (result.refusal !== null) {
        this.say(result.refusal, true)
        return
      }
      if (result.total === 0) {
        this.say(`No match for ${motifLabel(pattern, bothStrands)}.`)
        return
      }
      this.adopt(result, pattern, bothStrands)
    } catch (err) {
      this.say(err instanceof Error ? err.message : String(err), true)
    } finally {
      this.busy = false
      this.go.disabled = false
    }
  }

  /**
   * Put the sites on screen, as the two lanes `motifTrack.ts` builds.
   *
   * The feature lane is finished the moment it is made — a `FeatureSet` lives on
   * the main thread so a pan redraws with no round trip — while the density lane
   * has to be registered with the worker before it can answer a `sample`, which
   * is the same two-step every synthetic track goes through
   * (`analysis/workspace.ts`). The row is created first and marked ready after,
   * so a slow registration shows as a loading row rather than as nothing.
   */
  private adopt(result: MotifScanResult, pattern: string, bothStrands: boolean): void {
    const store = this.props.store
    const label = motifLabel(pattern, bothStrands)
    const sites = `${fmt.int(result.total)} site${result.total === 1 ? '' : 's'}`

    const featureId = `${MOTIF_PREFIX}${label}`
    store.begin({
      card: 'overlay',
      kind: 'segments',
      id: featureId,
      label,
      source: { kind: 'derived', name: label },
      placement: placementOn('bottom'),
      style: defaultStyle('segments', store.nextColour()),
    })
    store.update(featureId, {
      status: 'ready',
      payload: { kind: 'features', data: motifFeatures(result, pattern) },
      summary: `${sites}, found by searching the reference`,
    })

    const contigs = this.props.contigs()
    if (contigs.length > 0) {
      const total = contigs.reduce((sum, contig) => sum + contig.length, 0)
      const binsize = motifBinsize(total)
      const vector = motifDensity(result, contigs, binsize)
      const densityId = `${MOTIF_PREFIX}density:${label}`
      store.begin({
        card: 'linear',
        kind: 'track',
        id: densityId,
        label: `${label} density`,
        source: { kind: 'derived', name: `${label} density` },
        placement: placementOn('bottom'),
        style: defaultStyle('track', store.nextColour()),
      })
      let max = 0
      for (const value of vector.values) if (value > max) max = value
      void this.props.client
        .request<'register'>({ kind: 'register', entry: densityId, vector })
        .then(() => {
          store.update(densityId, { status: 'ready', fileExtent: { min: 0, max } })
        })
        .catch((err: unknown) => {
          store.update(densityId, {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          })
        })
      this.say(
        `${sites}${result.truncated ? ' — stopped at the limit, there are more' : ''}. ` +
          `Two lanes: the sites, and their density per ${fmt.bp(binsize)}.`,
        result.truncated,
      )
      return
    }
    this.say(
      `${sites}${result.truncated ? ' — stopped at the limit, there are more' : ''}.`,
      result.truncated,
    )
  }
}
