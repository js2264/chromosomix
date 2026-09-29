/**
 * The breadcrumb: `genomes → genome → contig → region` (spec §5.5).
 *
 * Every segment is clickable to go back up, which is the only navigation
 * affordance the app needs given that the view state is one flat object.
 *
 * Two segments are pickers rather than links, because they select *what is
 * open* rather than move within it:
 *
 * - **the entry picker**, shown only for an mmetacool, which chooses which
 *   nested metacool the rest of the trail describes (§3.4). It precedes the
 *   root because switching entry invalidates every crumb after it.
 * - **the root picker**, which chooses between the genomes and the contigs
 *   table. Both are landing views over the same file, so a link between them
 *   would be a crumb that goes sideways; a select says "pick a table".
 *
 * For a plain cooler the root picker collapses to plain text: the synthesised
 * single-genome table has nothing to show (§9), so `contigs` is the only choice.
 */

import { KEYS, keyBadge, withKey } from './commands'
import { icon } from './icons'
import { windowLabel } from '../genome/assembly'
import { cellsOf, selectionOf } from '../state/ViewState'
import type { DerivedRung, Rung } from '../metacooler/coarsen'
import type { ViewState } from '../types'
import { el } from './dom'
import { resolutionLabel } from '../units'

/** Re-exported: the label moved to `src/units.ts`, and this is where callers found it. */
export { resolutionLabel }

/**
 * The four things the root crumb can be.
 *
 * All four are {@link ViewState} views, which is what lets this picker be one
 * thing: every entry navigates, and the crumb reads the answer back off the
 * state. `overview` was the exception — a mode the shell held beside the state —
 * and every place that knew it was routed around the trail rather than through
 * it.
 */
export type RootChoice = 'genomes' | 'cells' | 'contigs' | 'overview' | 'whole'

/**
 * Title Case, because these are the names of views, not field values.
 *
 * `contigs` is *Chromosomes* on a cooler. The word is not cosmetic: a cooler
 * holds one genome's chromosomes, and calling them contigs asks the reader to
 * translate on every screen. `overview` and `whole` answer the same question —
 * the whole file at once — by different means, and each is named for what that
 * file holds: a metagenome's is the whole *meta*genome, which is what its
 * palette entry and its headings say too.
 */
const ROOT_LABEL: Record<RootChoice, string> = {
  genomes: 'Genomes',
  cells: 'Cells',
  contigs: 'Contigs',
  overview: 'Whole metagenome',
  whole: 'Whole genome',
}

/**
 * The key that reaches each landing view, for the tooltips on this crumb.
 *
 * The same three keys the command list binds, read from the same place: a
 * reader who finds "Whole genome" here and presses W in the table next time is
 * doing what this tooltip told them to.
 */
const ROOT_KEYS: Record<RootChoice, string> = {
  genomes: KEYS.genomes,
  // The same key as Genomes, and deliberately — see `KEYS.genomes`.
  cells: KEYS.genomes,
  contigs: KEYS.contigs,
  overview: KEYS.whole,
  whole: KEYS.whole,
}

export interface BreadcrumbProps {
  /** Root of the hierarchy: the landing view for this kind of file. */
  rootKind: 'genomes' | 'cells' | 'contigs'
  /** Landing views this file can offer. One entry hides the picker. */
  rootChoices: RootChoice[]
  /**
   * Choices to show but not offer, with the reason.
   *
   * A cooler has no genomes, and *hiding* the entry would leave the reader
   * wondering whether this viewer has a genomes table at all. Greyed out with
   * a reason answers the question instead of raising it.
   */
  disabledChoices?: Partial<Record<RootChoice, string>>
  /** What a contig is called in this file: `Contigs`, or `Chromosomes`. */
  contigNoun?: string
  /**
   * A genome browsed as tracks (§5.8), with no map behind it.
   *
   * Its *whole genome* is the browser rather than a map, so that choice goes to
   * `view=browser`; and its *chromosomes* are the sequence list the genome was
   * built from, which is where a circle and an origin are declared with no map
   * open (§8.15).
   */
  browser?: boolean
  /** Short label for the open file, shown as the first crumb. */
  fileLabel: string
  /** Entry names of the enclosing mmetacool, or `[]` for a plain metacool. */
  entries: string[]
  /** The entry currently open, when {@link entries} is non-empty. */
  currentEntry?: string
  /** What one entry is called in this format: an entry, or a resolution. */
  entryNoun?: string
  /**
   * Cells in the open `.scool`, for the crumb that says which are being summed;
   * `0` for every other container.
   */
  cellCount?: number
  onNavigate(state: ViewState): void
  /**
   * The file crumb was clicked. It opens a file *over* the current view rather
   * than navigating away to ask, so that changing your mind costs nothing —
   * a dropped local file cannot be re-opened without another gesture (§11), so
   * leaving the view to look at the picker used to be one-way.
   */
  onOpenFile(): void
  /** An mmetacool entry was picked; the caller re-opens the file at it. */
  onSelectEntry?(entry: string): void
  /**
   * The ladder to draw, where it is not simply {@link entries} (§3.4).
   *
   * The file's own rungs with the reader's added ones merged in, in bin-size
   * order, each of the added ones carrying the arithmetic that reaches it
   * (`metacooler/coarsen.ts`). Given by the session because *which* resolutions
   * a reader has added is a fact it holds and this component must not go
   * looking for; absent is every caller that has none, and then the ladder is
   * read off `entries` exactly as it always was.
   *
   * A function, not a list, and the reason is the whole of what `+` does: the
   * bar is built once per open file and re-rendered on every state change, so a
   * list captured at construction would never contain the resolution the reader
   * had just added. Asked per render, the row is the ladder as it stands.
   */
  ladder?(): ReadonlyArray<Rung & { derived?: DerivedRung }>
  /**
   * The bin size on screen, when it is one the reader added rather than a rung.
   *
   * A function for {@link ladder}'s reason and for a second: under a derived
   * rung the file is open at its *base*, so `currentEntry` says `1000` while the
   * axis says 10 kb, and which it is changes on every patch of the hash.
   */
  coarsen?(): number | undefined
  /**
   * A rung of the **file's own** ladder was picked, by entry name.
   *
   * Separate from {@link onSelectEntry}, which is the plain entry picker a
   * collection of replicates gets, because the two do different things where a
   * derived resolution is showing: picking a stored rung there has to *stop*
   * coarsening as well as move, and on a plain `.cool` — one rung, no entries —
   * it has nothing to open at all and stopping is the whole of it. Falls back to
   * {@link onSelectEntry} when a caller offers no such distinction.
   */
  onSelectRung?(entry: string): void
  /** A resolution the reader added was picked — its bin size, in bp. */
  onSelectDerived?(binsize: number): void
  /** The `+` was pressed: offer to add a resolution the file does not store. */
  onAddResolution?(): void
  /** The × on an added resolution was pressed — take it back off the ladder. */
  onDropResolution?(binsize: number): void
  /**
   * The *contacts* box (§6.5), at the far end past the resolution.
   *
   * An element the session owns and this bar only seats, because the bar is
   * rebuilt on every change of the view — every pan — and a box rebuilt under
   * the reader's cursor loses what they were typing. Absent in a bar with no map
   * behind it.
   */
  contacts?: { el: HTMLElement; sync(): void }
}

/**
 * Which table a view was reached through — the crumb that leads back to it.
 *
 * A table view names itself. Below that the trail used to fall back to the
 * file's *default* root, so opening a contig from the Contigs table produced
 * "Genomes > NODE_18007", a path that does not exist and that leads back to a
 * table the reader was never in.
 *
 * The signal is already in the state and needs no remembering: a contig opened
 * from within a genome carries that genome (`region` beside `genome`), and one
 * opened from the contigs table does not. Reading it off the state rather than
 * off a mode means a shared link rebuilds the same trail as the session that
 * produced it.
 */
export function rootTable(
  state: ViewState,
  fallback: 'genomes' | 'cells' | 'contigs',
): 'genomes' | 'cells' | 'contigs' {
  if (state.view === 'genomes' || state.view === 'contigs' || state.view === 'cells') {
    return state.view
  }
  if (state.view === 'region') return state.genome === undefined ? 'contigs' : 'genomes'
  // A selection leads back to the table it was ticked in, which is the one that
  // can un-tick it. A `selection` naming nothing is not one, and falls through
  // to the file's default like the other whole-file views — the shell redirects
  // it to one of them anyway.
  // Contigs ticked inside one genome carry it, and hang off that genome.
  const kind = state.view === 'selection' ? selectionOf(state)?.kind : undefined
  if (kind !== undefined) {
    return kind === 'genome' || state.genome !== undefined ? 'genomes' : 'contigs'
  }
  // A genome or a pair is by definition below the genomes table; `whole` and
  // `overview` are neither, and keep the file's own default.
  return state.genome === undefined ? fallback : 'genomes'
}

/**
 * Where the resolution radios' `name` comes from.
 *
 * One group per rendered bar rather than one per application: `render` replaces
 * the whole row, and two bars alive at once — a deck's panels, a tab being torn
 * down behind the one in front — sharing a group name would let a radio in the
 * old one unset the checked radio in the new.
 */
const GROUP_PREFIX = 'metacooler-resolution-'
let groups = 0

/**
 * How many rungs are drawn as a row of clickable stops.
 *
 * Nine, which is most of the `.mcool`s in the wild: a `zoomify` ladder that
 * doubles from 1 kb reaches a megabase in ten rungs, and one that walks the
 * 1–2–5 series reaches it in nine. Past that the slider carries the walk on its
 * own — see {@link Breadcrumb.pushResolution}.
 *
 * It was six, on the grounds that more would push the place the reader is
 * looking at off the left of a laptop screen. It does not: a stop is a short
 * number in a condensed face, nine of them is about three hundred pixels, and
 * the trail they sit beside is right-aligned into whatever is left. What six
 * actually cost was the aim-and-click on exactly the files that have the most
 * rungs to aim at — and now, on the files somebody is most likely to *add* a
 * rung to, since adding one to an eight-rung ladder used to collapse the row.
 */
const MAX_STOPS = 9

export class Breadcrumb {
  readonly el: HTMLElement

  constructor(private readonly props: BreadcrumbProps) {
    this.el = el('nav', { class: 'breadcrumb', attrs: { 'aria-label': 'breadcrumb' } })
  }

  /** Re-render for a state. Safe to call on every state change. */
  render(state: ViewState | null): void {
    // Everything but the contacts box goes, and the trail is built in front of
    // it: moving a focused input — even to where it already is — blurs it.
    const tail = this.props.contacts?.el
    for (const child of [...this.el.childNodes]) if (child !== tail) child.remove()
    if (state === null) {
      tail?.remove()
      this.append(el('span', { class: 'crumb current', text: 'open a file' }))
      return
    }
    this.trail(state)
    // No ladder in a browser: there is no matrix to read at a coarser grid, and
    // often no cooler behind the tracks at all — and so no contacts to draw.
    if (state.view === 'browser') {
      tail?.remove()
      return
    }
    // **Last, after the place.** The resolution is not a step of the trail: it
    // does not contain the crumbs before it and clicking it does not go
    // anywhere — it is how finely the same place is drawn. It spent a release as
    // the second crumb, between the file name and the table, which read as *this
    // file, then this resolution, then these chromosomes* and put a control the
    // reader changes often at the one end of the bar they scroll past on the way
    // to the coordinates.
    this.pushResolution()
    // …and after it, the total the maps are drawn to (§6.5): another answer to
    // *how the picture is drawn*, at the end of the bar where those live.
    if (this.props.contacts !== undefined) {
      if (tail !== undefined && tail.parentNode !== this.el) this.el.appendChild(tail)
      this.props.contacts.sync()
    }
  }

  /** Add to the bar, in front of the contacts box where it is seated. */
  private append(node: Node): void {
    const tail = this.props.contacts?.el
    if (tail !== undefined && tail.parentNode === this.el) this.el.insertBefore(node, tail)
    else this.el.appendChild(node)
  }

  /** The trail proper: file → table → genome → contig → region. */
  private trail(state: ViewState): void {
    this.push(this.props.fileLabel, () => this.props.onOpenFile(), false, 'file')
    // **The 1D browser has a trail too**, and it used to have none: the host was
    // emptied in that branch, so the row that says which assembly and which
    // chromosome a reader is on vanished the moment the map's eye was pressed
    // and came back when it was pressed again. §5.5 gives every view a trail
    // and §21.3 has an embed carry "the ordinary breadcrumb"; a UCSC or IGV
    // reader looks for this row first, and "up" from a chromosome was not one
    // click anywhere in this view.
    if (state.view === 'browser') {
      this.pushBrowser(state)
      return
    }
    this.pushEntryPicker()
    this.pushRootPicker(state)
    this.pushCells(state)

    // A selection hangs off the table it was made in: several genomes are below
    // the genomes table, several contigs below the contigs one. Named while
    // there are few enough to read, counted after that — the same rule the
    // view's own heading follows, so the crumb and the heading agree.
    const selection = selectionOf(state)
    if (state.view === 'selection' && selection !== null) {
      const noun = selection.kind === 'genome' ? 'genomes' : (this.props.contigNoun ?? 'contigs')
      // Contigs ticked inside one genome (the Contigs card, §5.8) sit under it.
      if (selection.kind === 'contig' && state.genome !== undefined) {
        const genome = state.genome
        this.push(genome, () => this.props.onNavigate({ uri: state.uri, view: 'genome', genome }))
      }
      this.push(
        selection.names.length <= 3
          ? selection.names.join(' × ')
          : `${selection.names.length} ${noun.toLowerCase()}`,
        undefined,
        true,
      )
      return
    }

    if (state.view === 'pair' && state.genome !== undefined && state.genome2 !== undefined) {
      this.push(state.genome, () =>
        this.props.onNavigate({ uri: state.uri, view: 'genome', genome: state.genome }),
      )
      this.push(`${state.genome} × ${state.genome2}`, undefined, true)
      return
    }

    if (state.genome !== undefined) {
      const genomeState: ViewState = { uri: state.uri, view: 'genome', genome: state.genome }
      this.push(state.genome, () => this.props.onNavigate(genomeState), state.view === 'genome')
    }

    if (state.view === 'region' && state.region !== undefined) {
      const contig = state.region.split(':')[0]
      const hasCoordinates = state.region.includes(':')
      const contigState: ViewState = { uri: state.uri, view: 'region', region: contig, genome: state.genome }
      this.push(contig, hasCoordinates ? () => this.props.onNavigate(contigState) : undefined, !hasCoordinates)
      if (state.region2 !== undefined) {
        this.push(`${contig} × ${state.region2.split(':')[0]}`, undefined, true)
      } else if (hasCoordinates) {
        // The window alone, under the crumb that already names the sequence —
        // as the `contig × contig2` branch one line above does. It used to push
        // the whole region string, so the row ended "› IV › IV:1000000-1400000"
        // with the view's own heading and its locus box printing the same
        // string underneath: three copies of one place in three typefaces, and
        // a reader scanning them for a difference that is not there.
        this.push(windowLabel(state.region), undefined, true)
      }
    }
  }

  /**
   * A browser's trail: `genome › Whole genome › IV › 1,000,001-1,400,000`.
   *
   * The root is the whole assembly, because "the whole genome" is both where a
   * browser opens and the one place above the sequence in front of the reader.
   * Where the session also offers the genome's sequence list ({@link
   * BreadcrumbProps.browser}) the root is a picker between the two, exactly as
   * a map's is between its table and its whole; with nothing else to offer it
   * is a plain crumb, a control with one choice being absent rather than
   * greyed (§8.5).
   *
   * The locus is already the display form (`ViewState.locus` is 1-based
   * inclusive, written by `formatLocus`), so the sequence name is what is
   * before the colon and the window is what is after it. Under the sequence's
   * own crumb the window is printed alone: the map's last crumb repeated the
   * contig it hangs under, which put the same string on screen three times
   * running.
   */
  private pushBrowser(state: ViewState): void {
    const locus = state.locus
    const whole: ViewState = { uri: state.uri, view: 'browser' }
    // With its sequence list to pick as well (§5.8), the root is the same
    // picker a map's is: *Chromosomes* or *Whole genome*.
    if (this.props.browser === true && this.props.rootChoices.length > 1) {
      this.pushRootPicker(state)
    } else {
      this.push(
        ROOT_LABEL.whole,
        locus === undefined ? undefined : () => this.props.onNavigate(whole),
        locus === undefined,
      )
    }
    if (locus === undefined) return
    const colon = locus.lastIndexOf(':')
    const contig = colon < 0 ? locus : locus.slice(0, colon)
    this.push(
      contig,
      colon < 0 ? undefined : () => this.props.onNavigate({ ...whole, locus: contig }),
      colon < 0,
    )
    if (colon >= 0) this.push(locus.slice(colon + 1), undefined, true)
  }

  /**
   * Which cells the map below is summed from — an scool's second crumb (§3.8).
   *
   * It has to be *somewhere*, and this is the one place that is on screen in
   * every view: a cell set is not the subject of the view the way a genome is,
   * it is the subject of the **file**, and a reader three clicks into a locus
   * has otherwise nothing telling them whether they are looking at one cell or
   * four thousand. Which is the difference between a scatter of dots and a
   * contact map, so it must not be inferrable only from the picture.
   *
   * One cell is named; a handful are counted; everything is called *all*,
   * because that is the state the file opens in and a reader needs to be able
   * to tell it from a selection that happens to be large. Clicking returns to
   * the table where the ticks are, which is the only place the set changes.
   */
  private pushCells(state: ViewState): void {
    const total = this.props.cellCount ?? 0
    if (total === 0 || state.view === 'cells') return
    const names = cellsOf(state)
    const label =
      names === null
        ? `all ${total.toLocaleString()} cells`
        : names.length === 1
          ? (names[0] ?? '')
          : `${names.length.toLocaleString()} cells`
    this.separator()
    const crumb = el('button', {
      class: 'crumb',
      type: 'button',
      text: label,
      title:
        names === null
          ? `Every cell in this file, added together. Back to the cells table to choose fewer.`
          : names.length === 1
            ? `One cell: ${names[0]}. Back to the cells table to choose others.`
            : `${names.length.toLocaleString()} cells, added together: ${names.slice(0, 6).join(', ')}` +
              `${names.length > 6 ? ', …' : ''}. Back to the cells table to change them.`,
    })
    crumb.addEventListener('click', () =>
      this.props.onNavigate({ uri: state.uri, view: 'cells', cells: state.cells }),
    )
    this.append(crumb)
  }

  /**
   * The mmetacool entry picker, before the root (§3.4).
   *
   * **Entries only, never resolutions.** A nested metacool is a different *file*
   * — switching it invalidates every crumb after it, which is why it precedes the
   * root — so it is a step of the trail and belongs in the trail. A rung of a
   * `zoomify` ladder is the same file drawn more or less finely, so it is not,
   * and it has its own control at the far end ({@link pushResolution}).
   */
  private pushEntryPicker(): void {
    const { entries, currentEntry, onSelectEntry } = this.props
    if (entries.length === 0 || onSelectEntry === undefined) return
    if (this.ladder() !== null) return
    const select = el('select', { class: 'crumb-select', title: 'Nested metacool to view' })
    for (const name of entries) {
      select.appendChild(el('option', { value: name, text: name }))
    }
    if (currentEntry !== undefined) select.value = currentEntry
    select.addEventListener('change', () => onSelectEntry(select.value))
    this.separator()
    this.append(select)
  }

  /**
   * The rungs of this file, finest first — or `null` when it has no ladder.
   *
   * §3.4's rule, and the same one `ui/refine.ts` applies to decide whether a
   * collection is a ladder or a set of samples: every entry name parses as a
   * positive integer. A collection of replicates called `1`, `2`, `3` would pass
   * it, and it is the rule the whole application already reads that file by, so
   * this agreeing with it is the point.
   */
  private ladder(): Array<Rung & { derived?: DerivedRung }> | null {
    const { entries, onSelectEntry } = this.props
    // **The session's merged ladder wins where it gave one**, and it is given
    // for a plain `.cool` too — one rung, no entries, and a `+` beside it. The
    // read below is what a caller that knows nothing of derived resolutions
    // still gets, which is the picker exactly as it was.
    const given = this.props.ladder?.()
    if (given !== undefined && given.length > 0) return [...given]
    if (entries.length === 0 || onSelectEntry === undefined) return null
    if (this.props.entryNoun !== 'resolution') return null
    if (!entries.every((name) => /^\d+$/.test(name) && Number(name) > 0)) return null
    return entries
      .map((name) => ({ name, binsize: Number(name) }))
      .sort((a, b) => a.binsize - b.binsize)
  }

  /**
   * Which rung of {@link ladder} is on screen.
   *
   * The reader's declared bin size where they are on one, and the open entry's
   * name otherwise — two questions with one answer, because a derived rung has
   * no entry and the entry that is open under one is its *base*. Reading
   * `currentEntry` alone would put the highlight on the 1 kb stop while the axis
   * said 3 kb.
   */
  private standingAt(rungs: ReadonlyArray<Rung & { derived?: DerivedRung }>): number {
    const coarsen = this.props.coarsen?.()
    if (coarsen !== undefined) {
      const at = rungs.findIndex((rung) => rung.binsize === coarsen)
      if (at >= 0) return at
    }
    return Math.max(
      0,
      rungs.findIndex((rung) => rung.derived === undefined && rung.name === this.props.currentEntry),
    )
  }

  /**
   * Pick a rung, whichever kind it is.
   *
   * One callback out of the picker rather than two paths through it: a stop is a
   * stop, and which of the two roads it takes — re-open the file at an entry, or
   * stay where you are and pool — is the session's business and not the bar's.
   */
  /**
   * The × that takes an added resolution back off the ladder.
   *
   * An empty fragment where the session offers no way to remove one, so the two
   * shapes of stop — the chip a thinned ladder draws and the radio a listed one
   * does — can both append it without asking twice.
   */
  private dropButton(binsize: number, label: string): HTMLElement {
    const drop = this.props.onDropResolution
    if (drop === undefined) return el('span', { class: 'res-drop-absent' })
    const off = el('button', {
      class: 'btn btn-icon res-drop',
      type: 'button',
      title: `Remove ${label} from this file’s ladder`,
      attrs: { 'aria-label': `Remove ${label}` },
      on: {
        // A listed stop is a `<label>` wrapping a radio, so a press anywhere
        // inside it selects the rung. Removing one is not selecting it.
        click: (event: Event) => {
          event.preventDefault()
          event.stopPropagation()
          drop(binsize)
        },
      },
    })
    off.append(icon('x', { size: 10 }))
    return off
  }

  private pick(rung: Rung & { derived?: DerivedRung }): void {
    if (rung.derived !== undefined) this.props.onSelectDerived?.(rung.binsize)
    else (this.props.onSelectRung ?? this.props.onSelectEntry)?.(rung.name)
  }

  /**
   * Every rung as a dropdown, for a ladder too long to lay out as stops.
   *
   * The word `resolution` stays where it is and this sits beside it, so the row
   * reads the way it reads at every other length — a label and its control —
   * and the control *is* the list: a 4DN `.mcool` has eleven rungs and all
   * eleven are in it, in the ladder's own order, each wearing the `*` and the
   * tooltip its chip would have worn. What it replaces said less in the same
   * space: a slider, which shows how many rungs there are and names none of
   * them, and one chip naming the rung you are on.
   *
   * The × for a rung the reader added cannot live inside a `<select>`, so it
   * follows the picker when the rung being read is one of theirs — the same
   * button the chip carries, in the one place it can still be reached.
   */
  private ladderPicker(rungs: Array<Rung & { derived?: DerivedRung }>, at: number): HTMLElement {
    const select = el('select', {
      class: 'select res-pick',
      attrs: { 'aria-label': 'resolution' },
    }) as HTMLSelectElement
    for (const [index, rung] of rungs.entries()) {
      select.appendChild(
        el('option', {
          value: String(index),
          text: resolutionLabel(rung.binsize) + (rung.derived === undefined ? '' : '*'),
          attrs: { title: this.rungWhy(rung) },
        }),
      )
    }
    select.value = String(at)
    select.addEventListener('change', () => {
      const picked = rungs[Number(select.value)]
      if (picked !== undefined) this.pick(picked)
    })
    const standing = rungs[at]
    if (standing?.derived === undefined) return select
    const label = resolutionLabel(standing.binsize) + '*'
    return el('span', { class: 'res-pick-wrap' }, select, this.dropButton(standing.binsize, label))
  }

  /** What a rung is, in bins — the same sentence its chip and its option carry. */
  private rungWhy(rung: Rung & { derived?: DerivedRung }): string {
    return rung.derived === undefined
      ? `${rung.binsize.toLocaleString('en-US')} bp per bin`
      : `${rung.binsize.toLocaleString('en-US')} bp per bin — not in this file: ` +
          `${rung.derived.factor} of its ${rung.derived.from.binsize.toLocaleString('en-US')} bp bins, added up`
  }

  /**
   * The resolution, at the far end of the bar: a slider over a row of stops.
   *
   * It was a `<select>` of raw bin counts — `1000`, `5000`, `50000` — sitting
   * second in the trail. Three things were wrong with that and each of them is
   * answered here.
   *
   * **It read as a step of the trail**, which it is not: a rung is the same file
   * at a different grain, and the crumbs after it stay exactly where they were.
   * So it goes last, past the coordinates, where the controls over the picture
   * live.
   *
   * **It was in bins.** `50000` is a number a reader has to divide before it
   * means anything, and the answer — 50 kb — is the unit every other length in
   * this application is written in ({@link resolutionLabel}).
   *
   * **A dropdown hides the ladder.** A `zoomify` ladder is an *ordered* thing
   * with a fixed number of rungs, and that is exactly what a slider over labelled
   * stops shows: how many there are, which one you are on, and which way is
   * finer. Both halves write the same value — the stops are real radios, so the
   * arrow keys and a screen reader get the list, and the slider is the hand's
   * version of the same walk.
   *
   * **And a `+` past the coarse end** (§3.4). The rungs a file has are the ones
   * whoever ran `cooler zoomify` chose to write, and a reader who wants a 10 kb
   * picture of a file that stops at 4 kb can have one for nothing: a 10 kb bin
   * is a whole number of stored bins added up. It sits at the coarse end because
   * that is the direction the arithmetic goes — bins can be added, never split
   * — even though what comes back may land anywhere in the row. A resolution the
   * reader added wears a `*`, because it is not in the file and a methods section
   * that said it was would be wrong.
   */
  private pushResolution(): void {
    const rungs = this.ladder()
    if (rungs === null) return
    const onAdd = this.props.onAddResolution
    // One rung and no way to add a second is not a ladder; one rung *and* a `+`
    // is the whole feature on a plain `.cool`, so the row is drawn for it.
    if (rungs.length < 2 && onAdd === undefined) return
    const at = this.standingAt(rungs)

    const group = `${GROUP_PREFIX}${groups++}`
    // **Past a handful of rungs the stops stop being stops.** Eleven chips is
    // six hundred pixels of breadcrumb, which pushes the place the reader is
    // looking at off the left of a laptop screen — and a `.mcool` published by
    // 4DN has eleven. Above the cap the row collapses to a dropdown beside the
    // word (see {@link ladderPicker}), which is the one shape that still *shows*
    // every rung: what stood here before was the slider plus a single chip, and
    // between them they said where the walk had got to without ever saying what
    // else there was to walk to.
    const listed = rungs.length <= MAX_STOPS
    const stops = el('div', {
      class: 'res-stops',
      attrs: listed ? { role: 'radiogroup', 'aria-label': 'resolution' } : {},
    })
    // **A one-rung ladder is drawn without a slider.** There is nothing to slide
    // along, and the comment that used to stand here said so and then disabled
    // the control anyway — which is furniture by its own account, and against
    // the rule §8.5 and §18.1 both state: a control that cannot keep its
    // promise is absent, not greyed. A plain `.cool` is the commonest file a
    // lab opens, so the dead slider was on the row every reader looks at, and a
    // greyed track beside a single chip invites a drag that does nothing. It
    // comes back with the second rung, which is what the `+` beside it makes.
    const slider =
      rungs.length < 2 || !listed
        ? null
        : (el('input', {
            class: 'res-slider',
            type: 'range',
            title: `Drag to a coarser or finer resolution — ${rungs
              .map((rung) => resolutionLabel(rung.binsize))
              .join(', ')}`,
            attrs: {
              min: '0',
              max: String(rungs.length - 1),
              step: '1',
              'aria-label': 'resolution',
            },
          }) as HTMLInputElement)
    if (slider !== null) slider.value = String(at)

    for (const [index, rung] of rungs.entries()) {
      // **The `*` is part of the label, not a decoration beside it.** A reader
      // quoting `3 kb` in a methods section is quoting something this file does
      // not contain, and the one place that fact is certain to be read is the
      // number itself.
      const label = resolutionLabel(rung.binsize) + (rung.derived === undefined ? '' : '*')
      const why = this.rungWhy(rung)
      if (!listed) continue
      const radio = el('input', {
        class: 'res-radio',
        type: 'radio',
        attrs: { name: group, value: rung.name },
      }) as HTMLInputElement
      radio.checked = index === at
      radio.addEventListener('change', () => {
        if (radio.checked) this.pick(rung)
      })
      const stop = el(
        'label',
        {
          class: `res-stop${index === at ? ' current' : ''}${rung.derived === undefined ? '' : ' res-added'}`,
          title: why,
        },
        radio,
        el('span', { text: label }),
      )
      // Taking one back off, on the stop it is about. Not offered for the
      // file's own rungs, which are not the reader's to remove — and that
      // asymmetry is the second thing the `*` is saying.
      if (rung.derived !== undefined) stop.appendChild(this.dropButton(rung.binsize, label))
      stops.appendChild(stop)
    }

    // On `change`, not `input`: dragging across a five-rung ladder would
    // otherwise re-open the file at every rung it passed over, which is four
    // reads nobody asked for and a picture that flickers through them.
    slider?.addEventListener('change', () => {
      const picked = rungs[Number(slider.value)]
      if (picked !== undefined && rungs.indexOf(picked) !== at) this.pick(picked)
    })

    this.append(
      el(
        'div',
        {
          class: 'crumb-res',
          title:
            'How finely this file is drawn — the rungs of its own zoomify ladder. ' +
            'A coarser rung is a smaller read and a blockier picture; the place on screen does ' +
            'not change.',
        },
        el('span', { class: 'res-label', text: 'resolution' }),
        ...(slider === null ? [] : [slider]),
        ...(listed ? [stops] : [this.ladderPicker(rungs, at)]),
        ...(onAdd === undefined
          ? []
          : [
              el(
                'button',
                {
                  class: 'btn btn-icon res-add',
                  type: 'button',
                  attrs: {
                    'aria-label': 'Add a resolution',
                    title:
                      'Look at this map at a resolution the file does not store — any whole ' +
                      'number of its own bins added up.',
                  },
                  on: { click: () => onAdd() },
                },
                icon('plus', { size: 12 }),
              ),
            ]),
      ),
    )
  }

  /**
   * The root crumb: a link *plus* a picker, not a picker alone.
   *
   * Making the whole crumb a `<select>` cost the trail its main job — one click
   * back to the table you came from. Going up is the common action and stays a
   * one-click link; switching table is the rare one and gets the arrow beside
   * it.
   */
  private pushRootPicker(state: ViewState): void {
    const { rootChoices, rootKind } = this.props
    const table: 'genomes' | 'cells' | 'contigs' = rootTable(state, rootKind)
    // The whole-file views belong in this crumb as much as the tables do:
    // leaving them out left them labelled "Chromosomes", so the only sign
    // anything had happened was the heatmap itself. A genome's whole is its
    // browser, which is at the root while no sequence is named in it.
    const browsing = this.props.browser === true && state.view === 'browser'
    const whole =
      state.view === 'whole' || state.view === 'overview' ? state.view : browsing ? 'whole' : null
    const active: RootChoice = whole ?? table
    const atRoot = browsing ? state.locus === undefined : whole !== null || state.view === table
    const viewOf = (kind: RootChoice): ViewState['view'] =>
      this.props.browser === true && kind === 'whole' ? 'browser' : kind

    this.separator()

    const labelOf = (kind: RootChoice): string =>
      kind === 'contigs' ? (this.props.contigNoun ?? ROOT_LABEL.contigs) : ROOT_LABEL[kind]

    const label = el('button', {
      class: `crumb${atRoot ? ' current' : ''}`,
      type: 'button',
      text: labelOf(active),
      title: withKey(`Back to ${labelOf(active)}`, ROOT_KEYS[active]),
    })
    label.addEventListener('click', () =>
      this.props.onNavigate({ uri: state.uri, view: viewOf(active) }),
    )

    if (rootChoices.length < 2) {
      this.append(label)
      return
    }

    const other = rootChoices.filter((kind) => kind !== active).map(labelOf)
    const arrow = el('button', {
      class: 'crumb-arrow',
      type: 'button',
      title: `Switch to the ${other.join(' or ')} table`,
      attrs: { 'aria-label': 'choose which table to browse' },
    })
    arrow.appendChild(icon('chevron-down', { size: 14 }))
    const menu = el('div', { class: 'crumb-menu hidden' })
    for (const kind of rootChoices) {
      const why = this.props.disabledChoices?.[kind]
      const item = el('button', {
        class: `crumb-menu-item${kind === active ? ' current' : ''}${why === undefined ? '' : ' disabled'}`,
        type: 'button',
        text: labelOf(kind),
        title: why ?? withKey(`Go to ${labelOf(kind)}`, ROOT_KEYS[kind]),
      })
      // The key beside the word, for the entries that can be reached by one.
      // The disabled entry says why it is disabled instead: a shortcut printed
      // next to something that cannot be done is a shortcut that does nothing.
      if (why === undefined) item.appendChild(keyBadge(ROOT_KEYS[kind], { class: 'kbd-inline' }))
      if (why !== undefined) {
        item.disabled = true
      } else {
        item.addEventListener('click', () => {
          menu.classList.add('hidden')
          this.props.onNavigate({ uri: state.uri, view: viewOf(kind) })
        })
      }
      menu.appendChild(item)
    }
    arrow.setAttribute('aria-expanded', 'false')
    arrow.addEventListener('click', (event) => {
      event.stopPropagation()
      const opening = menu.classList.contains('hidden')
      menu.classList.toggle('hidden', !opening)
      arrow.setAttribute('aria-expanded', String(opening))
      if (opening) {
        // Placed against the viewport from the arrow's own rect: the crumb row
        // scrolls horizontally, and a scroller clips what hangs out of it.
        const rect = arrow.getBoundingClientRect()
        menu.style.top = `${rect.bottom + 4}px`
        menu.style.left = `${rect.left}px`
        // An outside click closes it, **and so does Escape**, which was the one
        // way out this menu did not have: every other transient surface in the
        // app takes it (the drawers, the console, the right-click menu, a
        // modal), so a floating list over the map was the only thing a reader
        // could not back out of by the key they press to back out of anything.
        // Each listener removes the other, so neither outlives the menu.
        const close = (): void => {
          menu.classList.add('hidden')
          arrow.setAttribute('aria-expanded', 'false')
          window.removeEventListener('click', close)
          window.removeEventListener('keydown', onKey, true)
        }
        const onKey = (event: KeyboardEvent): void => {
          if (event.key === 'Escape') close()
        }
        window.addEventListener('click', close, { once: true })
        window.addEventListener('keydown', onKey, true)
      }
    })
    this.append(el('span', { class: 'crumb-group' }, label, arrow, menu))
  }

  /** The active root, as a label — the shell uses it for the greyed entries. */
  static label(kind: RootChoice): string {
    return ROOT_LABEL[kind]
  }

  private separator(): void {
    const first = this.el.firstChild
    if (first !== null && first !== this.props.contacts?.el) {
      this.append(el('span', { class: 'crumb-sep' }, icon('chevron-right', { size: 14 })))
    }
  }

  private push(label: string, onClick?: () => void, current = false, extra = ''): void {
    this.separator()
    const className = `crumb${current ? ' current' : ''}${extra === '' ? '' : ` crumb-${extra}`}`
    // The file crumb is the one whose label does not describe what clicking it
    // does, so it is the one that has to say.
    const title = extra === 'file' ? `${label} — click to open another file` : label
    if (onClick === undefined || current) {
      this.append(el('span', { class: className, text: label, title }))
      return
    }
    const node = el('button', { class: className, type: 'button', text: label, title })
    node.addEventListener('click', onClick)
    this.append(node)
  }
}
