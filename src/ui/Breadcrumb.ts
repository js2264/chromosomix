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
import { selectionOf } from '../state/ViewState'
import type { ViewState } from '../types'
import { el } from './dom'

/**
 * The four things the root crumb can be.
 *
 * All four are {@link ViewState} views, which is what lets this picker be one
 * thing: every entry navigates, and the crumb reads the answer back off the
 * state. `overview` was the exception — a mode the shell held beside the state —
 * and every place that knew it was routed around the trail rather than through
 * it.
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
  /**
   * The file crumb was clicked. It opens a file *over* the current view rather
   * than navigating away to ask, so that changing your mind costs nothing —
   * a dropped local file cannot be re-opened without another gesture (§11), so
   * leaving the view to look at the picker used to be one-way.
   */
  onOpenFile(): void
  /** An mmetacool entry was picked; the caller re-opens the file at it. */
  onSelectEntry?(entry: string): void
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
export function rootTable(state: ViewState, fallback: 'genomes' | 'contigs'): 'genomes' | 'contigs' {
  if (state.view === 'genomes' || state.view === 'contigs') return state.view
  if (state.view === 'region') return state.genome === undefined ? 'contigs' : 'genomes'
  // A selection leads back to the table it was ticked in, which is the one that
  // can un-tick it. A `selection` naming nothing is not one, and falls through
  // to the file's default like the other whole-file views — the shell redirects
  // it to one of them anyway.
  const kind = state.view === 'selection' ? selectionOf(state)?.kind : undefined
  if (kind !== undefined) return kind === 'genome' ? 'genomes' : 'contigs'
  // A genome or a pair is by definition below the genomes table; `whole` and
  // `overview` are neither, and keep the file's own default.
  return state.genome === undefined ? fallback : 'genomes'
}

export class Breadcrumb {
  readonly el: HTMLElement

  constructor(private readonly props: BreadcrumbProps) {
    this.el = el('nav', { class: 'breadcrumb', attrs: { 'aria-label': 'breadcrumb' } })
  }

  /** Re-render for a state. Safe to call on every state change. */
  render(state: ViewState | null): void {
    this.el.replaceChildren()
    if (state === null) {
      this.el.appendChild(el('span', { class: 'crumb current', text: 'open a file' }))
      return
    }

    this.push(this.props.fileLabel, () => this.props.onOpenFile(), false, 'file')
    this.pushEntryPicker()
    this.pushRootPicker(state)

    // A selection hangs off the table it was made in: several genomes are below
    // the genomes table, several contigs below the contigs one. Named while
    // there are few enough to read, counted after that — the same rule the
    // view's own heading follows, so the crumb and the heading agree.
    const selection = selectionOf(state)
    if (state.view === 'selection' && selection !== null) {
      const noun = selection.kind === 'genome' ? 'genomes' : (this.props.contigNoun ?? 'contigs')
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
    const table: 'genomes' | 'contigs' = rootTable(state, rootKind)
    // The whole-file views belong in this crumb as much as the tables do:
    // leaving them out left them labelled "Chromosomes", so the only sign
    // anything had happened was the heatmap itself.
    const whole = state.view === 'whole' || state.view === 'overview' ? state.view : null
    const active: RootChoice = whole ?? table
    const atRoot = whole !== null || state.view === table

    this.separator()

    const labelOf = (kind: RootChoice): string =>
      kind === 'contigs' ? (this.props.contigNoun ?? ROOT_LABEL.contigs) : ROOT_LABEL[kind]

    const label = el('button', {
      class: `crumb${atRoot ? ' current' : ''}`,
      type: 'button',
      text: labelOf(active),
      title: `Back to ${labelOf(active)}`,
    })
    label.addEventListener('click', () =>
      this.props.onNavigate({ uri: state.uri, view: active }),
    )

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
          this.props.onNavigate({ uri: state.uri, view: kind })
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
    // The file crumb is the one whose label does not describe what clicking it
    // does, so it is the one that has to say.
    const title = extra === 'file' ? `${label} — click to open another file` : label
    if (onClick === undefined || current) {
      this.el.appendChild(el('span', { class: className, text: label, title }))
      return
    }
    const node = el('button', { class: className, type: 'button', text: label, title })
    node.addEventListener('click', onClick)
    this.el.appendChild(node)
  }
}
