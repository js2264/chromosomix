/**
 * The region view (spec §5.4): a `contig` or `contig:start-end` selection.
 *
 * Range parsing is not done here — it is delegated to the reader so that the
 * browser and `parse_metacooler_range` agree exactly, including the refusals:
 *
 * 1. a **genome name** expands to the whole-genome extent, and a coordinate
 *    suffix on a genome name is an *error*, not something quietly ignored;
 * 2. otherwise a **contig**, optionally with 1-based fully-closed coordinates;
 * 3. neither → an error listing the available genomes and contigs.
 *
 * Genome and contig namespaces can collide and genome wins, as in Python, so
 * the view states which kind the search matched rather than leaving the user to
 * infer it from the picture.
 */

import type { ParsedRange } from '../types'
import type { MatrixResult } from '../worker/protocol'
import { ViewerError } from '../errors'
import type { ReaderClient } from '../worker/client'
import { button, el, fmt } from './dom'
import type { ScaleState } from './GenomeView'
import { MatrixPanel } from './MatrixPanel'

export interface RegionViewProps {
  client: ReaderClient
  binsize: number
  region: string
  scale: ScaleState
  onChangeRegion(region: string): void
  onScaleChange(scale: ScaleState): void
  onOpenGenome(genome: string): void
  onError(err: unknown): void
}

export class RegionView {
  readonly el: HTMLElement
  private readonly panel: MatrixPanel
  private readonly input: HTMLInputElement
  private readonly matched: HTMLElement
  private readonly problem: HTMLElement
  private disposed = false

  constructor(private readonly props: RegionViewProps) {
    this.input = el('input', {
      class: 'input input-region',
      type: 'text',
      value: props.region,
      placeholder: 'contig, contig:start-end, or a genome name',
    })
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') props.onChangeRegion(this.input.value.trim())
    })
    this.matched = el('span', { class: 'match-kind' })
    this.problem = el('p', { class: 'inline-error hidden' })

    this.panel = new MatrixPanel({
      binsize: props.binsize,
      initial: props.scale,
      onScaleChange: (scale) => props.onScaleChange(scale),
      onCellClick: (_cell, groups) => {
        if (groups.row !== undefined && groups.row.label !== props.region) {
          props.onChangeRegion(groups.row.label)
        }
      },
    })

    this.el = el(
      'section',
      { class: 'view view-region' },
      el(
        'header',
        { class: 'view-head' },
        el('h2', { text: 'Region' }),
        el(
          'div',
          { class: 'region-bar' },
          this.input,
          button('go', () => props.onChangeRegion(this.input.value.trim())),
          this.matched,
        ),
        this.problem,
      ),
      this.panel.el,
    )

    void this.load()
  }

  destroy(): void {
    this.disposed = true
    this.panel.destroy()
  }

  private async load(): Promise<void> {
    if (this.props.region === '') return
    this.panel.setBusy(true)
    this.problem.classList.add('hidden')
    try {
      const parsed: ParsedRange = await this.props.client.request<'range'>({
        kind: 'range',
        range: this.props.region,
      })
      const [lo, hi] = parsed.extent
      const result: MatrixResult = await this.props.client.request<'matrix'>({
        kind: 'matrix',
        rows: [lo, hi],
      })
      if (this.disposed) return
      this.describeMatch(parsed, hi - lo)
      this.panel.setData(result, this.props.region)
    } catch (err) {
      // A bad range is a normal, recoverable typing mistake: keep the view and
      // its input, and report the reader's own wording inline. Anything else is
      // a real failure and belongs on the error screen.
      if (err instanceof ViewerError && (err.code === 'unknown-label' || err.code === 'genome-coordinate-suffix' || err.code === 'unbinned-not-displayable')) {
        this.panel.setBusy(false)
        this.problem.textContent = err.message
        this.problem.classList.remove('hidden')
        this.matched.textContent = ''
        return
      }
      this.props.onError(err)
    }
  }

  private describeMatch(parsed: ParsedRange, bins: number): void {
    const kind = parsed.kind === 'genome' ? 'genome' : 'contig'
    this.matched.textContent = `matched ${kind} ${parsed.label} · ${fmt.int(bins)} bins · bins ${fmt.int(parsed.extent[0])}–${fmt.int(parsed.extent[1] - 1)}`
    this.matched.classList.toggle('is-genome', parsed.kind === 'genome')
    if (parsed.kind === 'genome') {
      const open = button('open genome view →', () => this.props.onOpenGenome(parsed.label), {
        class: 'btn btn-quiet',
      })
      this.matched.replaceChildren(this.matched.textContent ?? '', open)
    }
  }
}
