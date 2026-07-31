/**
 * The breadcrumb: `genomes → genome → contig → region` (spec §5.5).
 *
 * Every segment is clickable to go back up, which is the only navigation
 * affordance the app needs given that the view state is one flat object. The
 * root segment is `genomes` for a metacool and `contigs` for a plain cooler,
 * where the synthesised single-genome table has nothing to show (§9).
 */

import type { ViewState } from '../types'
import { el } from './dom'

export interface BreadcrumbProps {
  /** Root of the hierarchy: the landing view for this kind of file. */
  rootKind: 'genomes' | 'contigs'
  /** Short label for the open file, shown as the first, non-clickable crumb. */
  fileLabel: string
  onNavigate(state: ViewState): void
  onOpenFilePicker(): void
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

    const root: ViewState = { uri: state.uri, view: this.props.rootKind }
    const atRoot = state.view === this.props.rootKind
    this.push(this.props.rootKind, () => this.props.onNavigate(root), atRoot)

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
      if (hasCoordinates) this.push(state.region, undefined, true)
    }
  }

  private push(label: string, onClick?: () => void, current = false, extra = ''): void {
    if (this.el.childNodes.length > 0) {
      this.el.appendChild(el('span', { class: 'crumb-sep', text: '›' }))
    }
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
