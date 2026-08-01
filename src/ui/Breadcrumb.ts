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

import { icon } from './icons'
import type { ViewState } from '../types'
import { el } from './dom'

/**
 * The three things the root crumb can be.
 *
 * `overview` is not a {@link ViewState} view — it is a mode the shell holds, and
 * it costs a full pixel scan — but it *is* a landing view of the whole file, the
 * same kind of thing as the two tables. It belongs in the picker beside them
 * rather than as a button in the corner of the window, which is where it was and
 * where nothing else about this file lives.
 */
export type RootChoice = 'genomes' | 'contigs' | 'overview' | 'whole'

/**
 * Title Case, because these are the names of views, not field values.
 *
 * `contigs` is *Chromosomes* on a cooler. The word is not cosmetic: a cooler
 * holds one genome's chromosomes, and calling them contigs asks the reader to
 * translate on every screen. `overview` and `whole` share a label because they
 * answer the same question — the whole file at once — by different means: a
 * pixel scan for a metagenome, one bounded read for a genome small enough.
 */
const ROOT_LABEL: Record<RootChoice, string> = {
  genomes: 'Genomes',
  contigs: 'Contigs',
  overview: 'Whole genome',
  whole: 'Whole genome',
}

export interface BreadcrumbProps {
  /** Root of the hierarchy: the landing view for this kind of file. */
  rootKind: 'genomes' | 'contigs'
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
  /** Short label for the open file, shown as the first crumb. */
  fileLabel: string
  /** Entry names of the enclosing mmetacool, or `[]` for a plain metacool. */
  entries: string[]
  /** The entry currently open, when {@link entries} is non-empty. */
  currentEntry?: string
  /** What one entry is called in this format: an entry, or a resolution. */
  entryNoun?: string
  onNavigate(state: ViewState): void
  onOpenFilePicker(): void
  /** The whole-genome view was picked from the root menu. */
  onShowOverview?(): void
  /** An mmetacool entry was picked; the caller re-opens the file at it. */
  onSelectEntry?(entry: string): void
}

export class Breadcrumb {
  readonly el: HTMLElement

  constructor(private readonly props: BreadcrumbProps) {
    this.el = el('nav', { class: 'breadcrumb', attrs: { 'aria-label': 'breadcrumb' } })
  }

  /** Whether the shell is showing the whole-genome view over this state. */
  private overviewActive = false

  /** Re-render for a state. Safe to call on every state change. */
  render(state: ViewState | null, options: { overview?: boolean } = {}): void {
    this.overviewActive = options.overview === true
    this.el.replaceChildren()
    if (state === null) {
      this.el.appendChild(el('span', { class: 'crumb current', text: 'open a file' }))
      return
    }

    this.push(this.props.fileLabel, () => this.props.onOpenFilePicker(), false, 'file')
    this.pushEntryPicker()
    this.pushRootPicker(state)

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
        this.push(state.region, undefined, true)
      }
    }
  }

  /** The mmetacool entry picker, before the root (§3.4). */
  private pushEntryPicker(): void {
    const { entries, currentEntry, onSelectEntry } = this.props
    if (entries.length === 0 || onSelectEntry === undefined) return
    const noun = this.props.entryNoun ?? 'entry'
    const select = el('select', {
      class: 'crumb-select',
      title: noun === 'resolution' ? 'Resolution to view' : 'Nested metacool to view',
    })
    for (const name of entries) {
      select.appendChild(el('option', { value: name, text: name }))
    }
    if (currentEntry !== undefined) select.value = currentEntry
    select.addEventListener('change', () => onSelectEntry(select.value))
    this.separator()
    this.el.appendChild(select)
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
    const table: 'genomes' | 'contigs' =
      state.view === 'genomes' || state.view === 'contigs' ? state.view : rootKind
    const active: RootChoice = this.overviewActive ? 'overview' : table
    const atRoot = this.overviewActive || state.view === table

    this.separator()

    const labelOf = (kind: RootChoice): string =>
      kind === 'contigs' ? (this.props.contigNoun ?? ROOT_LABEL.contigs) : ROOT_LABEL[kind]

    const label = el('button', {
      class: `crumb${atRoot ? ' current' : ''}`,
      type: 'button',
      text: labelOf(active),
      title: `Back to ${labelOf(active)}`,
    })
    label.addEventListener('click', () => this.chooseRoot(active, state))

    if (rootChoices.length < 2) {
      this.el.appendChild(label)
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
        ...(why === undefined ? {} : { title: why }),
      })
      if (why !== undefined) {
        item.disabled = true
      } else {
        item.addEventListener('click', () => {
          menu.classList.add('hidden')
          this.chooseRoot(kind, state)
        })
      }
      menu.appendChild(item)
    }
    arrow.addEventListener('click', (event) => {
      event.stopPropagation()
      const opening = menu.classList.contains('hidden')
      menu.classList.toggle('hidden', !opening)
      if (opening) {
        // Placed against the viewport from the arrow's own rect: the crumb row
        // scrolls horizontally, and a scroller clips what hangs out of it.
        const rect = arrow.getBoundingClientRect()
        menu.style.top = `${rect.bottom + 4}px`
        menu.style.left = `${rect.left}px`
        // One outside click closes it; `once` means no listener outlives the menu.
        window.addEventListener('click', () => menu.classList.add('hidden'), { once: true })
      }
    })
    this.el.appendChild(el('span', { class: 'crumb-group' }, label, arrow, menu))
  }

  /** Route a root choice: two of them are view states, one is a shell mode. */
  private chooseRoot(kind: RootChoice, state: ViewState): void {
    if (kind === 'overview') this.props.onShowOverview?.()
    else this.props.onNavigate({ uri: state.uri, view: kind })
  }

  /** The active root, as a label — the shell uses it for the greyed entries. */
  static label(kind: RootChoice): string {
    return ROOT_LABEL[kind]
  }

  private separator(): void {
    if (this.el.childNodes.length > 0) {
      this.el.appendChild(el('span', { class: 'crumb-sep' }, icon('chevron-right', { size: 14 })))
    }
  }

  private push(label: string, onClick?: () => void, current = false, extra = ''): void {
    this.separator()
    const className = `crumb${current ? ' current' : ''}${extra === '' ? '' : ` crumb-${extra}`}`
    if (onClick === undefined || current) {
      this.el.appendChild(el('span', { class: className, text: label, title: label }))
      return
    }
    const node = el('button', { class: className, type: 'button', text: label, title: label })
    node.addEventListener('click', onClick)
    this.el.appendChild(node)
  }
}
