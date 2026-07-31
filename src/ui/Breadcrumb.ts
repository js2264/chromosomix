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

import type { ViewState } from '../types'
import { el } from './dom'

export interface BreadcrumbProps {
  /** Root of the hierarchy: the landing view for this kind of file. */
  rootKind: 'genomes' | 'contigs'
  /** Landing tables this file can offer. One entry hides the picker. */
  rootChoices: Array<'genomes' | 'contigs'>
  /** Short label for the open file, shown as the first crumb. */
  fileLabel: string
  /** Entry names of the enclosing mmetacool, or `[]` for a plain metacool. */
  entries: string[]
  /** The entry currently open, when {@link entries} is non-empty. */
  currentEntry?: string
  onNavigate(state: ViewState): void
  onOpenFilePicker(): void
  /** An mmetacool entry was picked; the caller re-opens the file at it. */
  onSelectEntry?(entry: string): void
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
    const select = el('select', { class: 'crumb-select', title: 'Nested metacool to view' })
    for (const name of entries) {
      select.appendChild(el('option', { value: name, text: name }))
    }
    if (currentEntry !== undefined) select.value = currentEntry
    select.addEventListener('change', () => onSelectEntry(select.value))
    this.separator()
    this.el.appendChild(select)
  }

  /** The genomes/contigs table picker. */
  private pushRootPicker(state: ViewState): void {
    const { rootChoices, rootKind } = this.props
    const atRoot = state.view === 'genomes' || state.view === 'contigs'
    const active = atRoot ? state.view : rootKind

    if (rootChoices.length < 2) {
      const root: ViewState = { uri: state.uri, view: rootKind }
      this.push(rootKind, () => this.props.onNavigate(root), state.view === rootKind)
      return
    }

    const select = el('select', {
      class: `crumb-select${atRoot ? ' current' : ''}`,
      title: 'Which table to browse',
    })
    for (const kind of rootChoices) {
      select.appendChild(el('option', { value: kind, text: kind }))
    }
    select.value = active
    select.addEventListener('change', () => {
      this.props.onNavigate({ uri: state.uri, view: select.value as 'genomes' | 'contigs' })
    })
    this.separator()
    this.el.appendChild(select)
  }

  private separator(): void {
    if (this.el.childNodes.length > 0) {
      this.el.appendChild(el('span', { class: 'crumb-sep', text: '›' }))
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
