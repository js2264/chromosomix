/**
 * The **Bookmarks** card (spec §8.10): places worth coming back to.
 *
 * Under Manual annotations, and that ordering is the argument for the card
 * existing at all. The marks above it are things a reader draws *on* a picture;
 * these are pictures a reader wants *back*. Both are notes made while reading and
 * neither is in a file, which is why they are in the same column — but a mark
 * decorates where you are and a bookmark takes you somewhere, so the row's whole
 * affordance is the arrow at the end of it.
 *
 * ## What pressing one does, and why it is not just a region
 *
 * A saved place opens the **whole chromosome**, zoomed to the location on the
 * diagonal. Not `region=chrI:1200000-1260000`, which would cut a block at those
 * coordinates and leave the reader in a box with paper outside it. The block is
 * read whole and the *view* is placed, so the first thing anybody does on
 * arriving — pan out a little to see what is either side — works. That
 * distinction is carried by `ViewState.focus`, which is where the reasoning
 * lives.
 *
 * ## Three ways in, and they are three different moments
 *
 * The **button beside `go`** is for the place you are looking at: you have found
 * something and you want it back, and the round trip to a sidebar to retype
 * coordinates you are already looking at is the whole cost of not having it.
 * Typing into the card is for a coordinate you have from somewhere else — a
 * paper, a table, a colleague. **BED** is for a list of them, which is what
 * anybody who has called peaks or loops actually has in hand: forty places, and
 * the point is to walk them one after another rather than to type any of them.
 */

import {
  mintBookmarkId,
  parseRegion,
  regionsFromBed,
  type Bookmark,
  type BookmarkStore,
} from '../annotations/bookmarks'
import { button, el, fmt } from './dom'
import { resolutionLabel } from '../units'
import { cardTitle, icon, iconButton } from './icons'

export interface BookmarksCardProps {
  store: BookmarkStore
  /**
   * Take the reader to a saved place.
   *
   * The shell's job, not this card's: getting there is a navigation to a
   * resolution, a chromosome and a window, and only the session knows whether the
   * bin size asked for is one this file has.
   */
  go(mark: Bookmark): void
  /** `true` when there is a map on screen whose window could be saved. */
  available(): boolean
  /**
   * The stretch of genome the map is showing, or `null` when it is not at one
   * place — a whole-genome map framed across four chromosomes, a block of whole
   * contigs, a picture that has not been read yet.
   *
   * A function rather than a value because the card outlives every view mounted
   * under it: it is built once per file and the picture changes beneath it on
   * every navigation.
   */
  framed(): { contig: string; start: number; end: number; wrapped?: boolean } | null
  /** The bin size the map is open at, in bp, to save alongside a place. */
  binsize(): number | null
}

export class BookmarksCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly typed = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'II:120,000-180,000',
  })
  private readonly here: HTMLButtonElement
  private readonly note = el('p', { class: 'ann-note hidden' })
  private readonly unsubscribe: () => void

  constructor(private readonly props: BookmarksCardProps) {
    this.here = button('this view', () => this.saveFramed(), {
      class: 'btn',
      title: 'Save the stretch of genome on screen, at the resolution it is open at',
    })
    this.el = el(
      'section',
      { class: 'card annotation-card' },
      cardTitle('Bookmarks', 'bookmark'),
      // The ways in above the list, on the Tracks card's rule: with forty peaks
      // imported, the way to add a forty-first must not be below forty rows.
      this.addForm(),
      this.importRow(),
      this.note,
      this.list,
    )
    this.unsubscribe = props.store.subscribe(() => this.render())
    this.render()
  }

  destroy(): void {
    this.unsubscribe()
  }

  /**
   * Enable or disable *this view* as views come and go — `ManualCard.refresh`.
   *
   * On {@link BookmarksCardProps.available} rather than on `framed()`, and the
   * difference is a bug this had: the shell refreshes at the *moment* a view is
   * mounted, and a map is read asynchronously, so a panel that will have a window
   * in 200 ms has none right now. Disabling on the window left the button dead for
   * the whole life of every view.
   */
  refresh(): void {
    this.here.disabled = !this.props.available()
  }

  // -------------------------------------------------------------------------
  // Adding
  // -------------------------------------------------------------------------

  private addForm(): HTMLElement {
    const add = button('add', () => this.saveTyped(), {
      title: 'Save these coordinates at the resolution the map is open at',
    })
    this.typed.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') add.click()
    })
    return el(
      'div',
      { class: 'manual-form' },
      el('span', { class: 'manual-form-title', text: 'Save a place' }),
      el('div', { class: 'manual-row' }, this.typed),
      el('div', { class: 'manual-row' }, add, this.here),
    )
  }

  private saveTyped(): void {
    const region = parseRegion(this.typed.value)
    if (region === null) {
      this.typed.classList.add('is-bad')
      return
    }
    this.typed.classList.remove('is-bad')
    this.keep({ ...region, label: '' })
    this.typed.value = ''
  }

  /**
   * Save the window on screen.
   *
   * Public because the button beside `go` on the title line is the same act, and
   * two implementations of it would be two things to keep in step (§8.10). The
   * refusal is *said*, not swallowed: the two ways to reach this are both a press,
   * and a press that appears to do nothing is the worst of the three answers.
   */
  saveFramed(): void {
    const region = this.props.framed()
    if (region === null) {
      this.say(
        this.props.available()
          ? 'This picture is not at one place — zoom into a single sequence to bookmark it.'
          : 'No map is open to bookmark.',
      )
      return
    }
    // A window across a circular sequence's origin (§8.15) is one place and
    // cannot be written down as one: a bookmark leaves here as a BED interval,
    // and a BED interval whose end is below its start is not a BED interval. Said
    // in those words rather than through the sentence above, which would tell a
    // reader looking at a single sequence that they are not.
    if (region.wrapped === true) {
      this.say(
        'This window runs across the sequence’s own origin, which a bookmark cannot be written ' +
          'as — move off the junction, or bookmark the two halves.',
      )
      return
    }
    const { contig, start, end } = region
    this.keep({ contig, start, end, label: '' })
  }

  /**
   * One place, saved, with the grain it was found at.
   *
   * The bin size comes from the app rather than from the reader because it is not
   * a choice being made here — it is a fact about the map that is open, and a
   * bookmark's promise is to give back the picture the note was made against.
   *
   * A duplicate is reported rather than added. Pressing *this view* twice is what
   * anybody does when they cannot remember whether the first press worked, and
   * the useful answer to that is "yes, it is already there" and not a second
   * identical row (`BookmarkStore.add`).
   */
  private keep(mark: Omit<Bookmark, 'id' | 'binsize'>): void {
    const binsize = this.props.binsize()
    const added = this.props.store.add({
      ...mark,
      id: mintBookmarkId(),
      ...(binsize === null ? {} : { binsize }),
    })
    this.say(added ? null : 'That place is already bookmarked.')
  }

  // -------------------------------------------------------------------------
  // BED
  // -------------------------------------------------------------------------

  /**
   * A file of places, in.
   *
   * BED because that is the file a reader has: peak calls, loop calls, a table of
   * domains, the output of every tool that emits intervals. Only the first three
   * columns are read and the fourth is taken as the name if it is there
   * (`annotations/bookmarks.ts`), so a narrowPeak and a two-column-plus-header
   * table from R both import without being asked what they are.
   *
   * Deliberately *not* the Tracks card's drop zone. Dropping a BED there draws it
   * as a lane, which is the right answer to "show me these" — this is the answer
   * to "walk me through these", and one gesture must not mean both. Hence a
   * button that says which of the two it is, in the card whose list it fills.
   */
  private importRow(): HTMLElement {
    const input = el('input', { class: 'hidden-input', type: 'file' })
    input.accept = '.bed,.txt,.tsv,.narrowPeak,.broadPeak'
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      // Cleared so choosing the same file twice fires `change` the second time.
      input.value = ''
      if (file !== undefined) void this.readBed(file)
    })
    return el(
      'div',
      { class: 'manual-form' },
      el('span', { class: 'manual-form-title', text: 'Import' }),
      el(
        'div',
        { class: 'manual-row' },
        button('regions from BED…', () => input.click(), {
          title:
            'Every interval in the file becomes a bookmark. The first three columns are read, ' +
            'and the fourth is its name if it has one.',
        }),
        input,
      ),
    )
  }

  private async readBed(file: File): Promise<void> {
    let text: string
    try {
      text = await file.text()
    } catch {
      this.say(`${file.name} could not be read.`)
      return
    }
    const { regions, skipped } = regionsFromBed(text)
    if (regions.length === 0) {
      this.say(`No regions in ${file.name} — the first three columns should be name, start, end.`)
      return
    }
    // The file's own grain, which is none: a BED says where and not how coarse,
    // so these carry no bin size and open at whatever the map is at. Inventing
    // the current one would put a claim in the bookmark that the file never made.
    const added = this.props.store.addAll(
      regions.map((region) => ({ ...region, id: mintBookmarkId() })),
    )
    const parts = [`${added} of ${regions.length} added`]
    if (added < regions.length) parts.push('the rest were already saved')
    if (skipped > 0) parts.push(`${skipped} ${skipped === 1 ? 'line' : 'lines'} had no region`)
    this.say(`${file.name}: ${parts.join(', ')}.`)
  }

  /** One line under the list, or none. Cleared by the next thing that happens. */
  private say(message: string | null): void {
    this.note.textContent = message ?? ''
    this.note.classList.toggle('hidden', message === null)
  }

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  private render(): void {
    this.refresh()
    const marks = this.props.store.marks
    if (marks.length === 0) {
      this.list.replaceChildren()
      return
    }
    this.list.replaceChildren(
      ...marks.map((mark) => this.row(mark)),
      button('remove all', () => this.props.store.clear(), {
        class: 'btn btn-quiet btn-wide',
        title: 'Forget every saved place on this file',
      }),
    )
  }

  /**
   * One saved place: what it is, and an arrow.
   *
   * The whole row is the button, rather than a label with a small arrow beside
   * it. A list of coordinates gives no clue that clicking one does anything, and
   * a 14-pixel target for the card's only real action is a target readers miss —
   * so the arrow is the *sign* and the row is the surface. The × stays a control
   * of its own, outside the button, because forgetting a place and going to it are
   * not gestures to put a pixel apart.
   */
  private row(mark: Bookmark): HTMLElement {
    const go = button('', () => this.props.go(mark), {
      class: 'btn bookmark-go',
      title: `Open ${mark.contig} zoomed to this place${
        mark.binsize === undefined ? '' : `, at ${resolutionLabel(mark.binsize)} bins`
      } — the rest of the chromosome stays behind it`,
    })
    go.replaceChildren(
      el('span', { class: 'bookmark-where' }, ...whereOf(mark)),
      ...(mark.binsize === undefined
        ? []
        : [el('span', { class: 'bookmark-res', text: resolutionLabel(mark.binsize) })]),
      icon('arrow-right', { size: 14 }),
    )
    return el(
      'div',
      { class: 'ann-row bookmark-row' },
      el(
        'div',
        { class: 'ann-head' },
        go,
        iconButton('x', 'Forget this place', () => this.props.store.remove(mark.id), {
          class: 'btn-close',
          size: 14,
        }),
      ),
    )
  }
}

/**
 * A saved place, as the reader should read it.
 *
 * Two lines' worth in one: the name if the file gave one, and the coordinates
 * always. Named rows are what a BED of genes or loops produces and the name is
 * what the reader is looking for — but the coordinates are what makes two rows
 * called `peak_1` and `peak_1` tell themselves apart, so they are never dropped.
 */
function whereOf(mark: Bookmark): HTMLElement[] {
  const coords =
    mark.end > mark.start
      ? `${mark.contig}:${fmt.int(mark.start)}-${fmt.int(mark.end)}`
      : `${mark.contig}:${fmt.int(mark.start)}`
  if (mark.label === '') return [el('span', { class: 'bookmark-coords', text: coords })]
  return [
    el('span', { class: 'bookmark-name', text: mark.label }),
    el('span', { class: 'bookmark-coords', text: coords }),
  ]
}
