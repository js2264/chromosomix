/**
 * The file info panel: attributes, metadata, the unassigned QC statistic, and
 * the performance counters.
 *
 * Three things here are specified rather than chosen.
 *
 * **The unassigned statistic (§7.4).** The fraction of contigs and bins that
 * binning failed to assign is shown once, as a read-only number, phrased as
 * `unassigned: 1,204 contigs / 8.3% of bins`. It is a direct diagnostic of
 * binning quality; a metagenomics reader will look for it and a reviewer will
 * expect it. It is a *number, not a view*: it opens nothing, selects nothing,
 * and is not a row in any table. It is the sole exception to `__unbinned__`
 * being invisible, and no code path reaches the reserved genome through it —
 * this panel receives four integers, not an index.
 *
 * The §12 read counters and the §6.3 deep-validation control used to live here
 * too. They moved to the status bar: both are glanced at rather than read, and
 * a sidebar block spends permanent vertical space on something a single line
 * can carry.
 *
 * **The record host** is the one part of this panel that changes as you
 * navigate: the `/genomes` or `/contigs` row of whatever heatmap is on screen
 * ({@link RecordCard}). It sits directly under the File card, because those two
 * are what the reader is actually looking at — this file, this genome — while
 * the QC statistic and the stored metadata are consulted once and then ignored.
 * Those two stay last, in that order, wherever the record card is.
 *
 * **The sequences host** sits above it, and on a cooler it is what the record
 * card used to be. A *Chromosome* record described the one sequence already
 * named in the breadcrumb, and it could only ever describe one; the Sequences
 * card lists every chromosome the file has with a tick beside each, so the same
 * strip of panel now says both what is drawn and what else could be — one
 * ticked is that chromosome's block, several are those chromosomes against each
 * other, none is the whole genome. The Chromosomes *table* is untouched: it is
 * the place columns are sorted and read, and this is the place a picture is
 * chosen. A metacool has no host filled here — its unit is the genome, and a
 * list of a hundred thousand contigs is not a picker (see `Session`).
 *
 * The three annotation cards were here too, under the record card. They are now
 * the Annotations column (`SidePanel`): everything in this panel is read, and
 * everything in those is worked on, so the two wanted different amounts of room
 * and different scroll boxes.
 *
 * This panel is the body of the **General** column, and is the only one of the
 * three whose contents it does not own — the shell mounts it there.
 */

import type { OpenResult } from '../worker/protocol'
import { el, fmt } from './dom'
import { cardTitle, icon, iconButton } from './icons'
import { recordCard, type RecordSpec } from './RecordCard'

export interface InfoPanelProps {
  info: OpenResult
  /**
   * Close one of the two open files.
   *
   * Offered only while there are two: the button is what makes the comparison
   * reversible from where it is described, and `1` promotes the second file to
   * the first rather than closing the session — the map that remains is a
   * perfectly ordinary one-file map.
   */
  onCloseFile?(which: 1 | 2): void
}

/**
 * There is deliberately no "close the map" button here any more.
 *
 * It used to sit on the single File card, and it was the only way out of the
 * matrix — a one-way door, in the panel that *describes* the file rather than
 * the one that lists what is drawn. Both maps now have a row of their own in
 * the Annotations column's Contact maps card, each with the same eye a track
 * carries and an × beside it, so putting the matrix down and letting go of it
 * are two visibly different acts in the place a reader already goes to decide
 * what is on screen. General says what the file *is*; it does not decide
 * whether it is drawn.
 */

export class InfoPanel {
  readonly el: HTMLElement
  /** Empty on a table view; `:empty` in the stylesheet is what hides it. */
  private readonly recordHost = el('div', { class: 'record-host' })
  /**
   * The Sequences card, on a file whose chromosomes are a picker.
   *
   * A host rather than a card built here, because the list arrives with the
   * `/chroms` read and the ticks are the session's — this panel describes the
   * file, and which sequences are drawn is a fact about the *view*.
   */
  private readonly sequenceHost = el('div', { class: 'sequence-host' })
  /**
   * The File card(s). One while one file is open, two while two are.
   *
   * A host rather than a fixed card, because the second file arrives and leaves
   * without the rest of this panel changing: the QC statistic and the metadata
   * below describe the *first* file whichever way, since that is the file whose
   * genomes and attributes every other view is about.
   */
  private readonly fileHost = el('div', { class: 'file-host' })
  private compare: OpenResult | null = null

  constructor(private readonly props: InfoPanelProps) {
    this.el = el(
      'aside',
      { class: 'info-panel' },
      this.fileHost,
      this.sequenceHost,
      this.recordHost,
      this.unassignedBlock(),
      this.metadataBlock(),
    )
    this.paintFiles()
  }

  /**
   * Hang the Sequences card under the File card, or take it away.
   *
   * Called once per file, with the card the session built: rebuilding it on
   * every navigation would throw away the filter text and the scroll position of
   * a list a reader is working their way down, and the ticks follow the view on
   * their own (`SequenceSelection`).
   */
  setSequences(card: HTMLElement | null): void {
    this.sequenceHost.replaceChildren(...(card === null ? [] : [card]))
  }

  /**
   * Show the table row(s) behind the current view, or nothing at all.
   *
   * Called on every render, including with `[]`: a genome card left standing
   * over the genomes table would describe a heatmap that is no longer there.
   */
  setRecords(records: RecordSpec[]): void {
    this.recordHost.replaceChildren(...records.map(recordCard))
  }

  /**
   * Adopt, or drop, the second file.
   *
   * The heading is the tell: one file is *File*, two are *File 1* and *File 2*,
   * and the numbers are the triangles — 1 above the diagonal, 2 below it. The
   * mark beside each name says which without a legend.
   */
  setCompare(info: OpenResult | null): void {
    this.compare = info
    this.paintFiles()
  }

  private paintFiles(): void {
    if (this.compare === null) {
      this.fileHost.replaceChildren(
        el(
          'div',
          { class: 'card' },
          el(
            'h3',
            { class: 'file-head card-head' },
            icon('file', { size: 13 }),
            el('span', { class: 'file-name', text: 'File' }),
          ),
          this.fileTable(this.props.info),
        ),
      )
      return
    }
    this.fileHost.replaceChildren(
      this.fileCard(1, this.props.info),
      this.fileCard(2, this.compare),
    )
  }

  private fileCard(which: 1 | 2, info: OpenResult): HTMLElement {
    const close = this.props.onCloseFile
    return el(
      'div',
      { class: 'card card-file' },
      el(
        'h3',
        { class: 'file-head card-head' },
        el('span', {
          class: `compare-mark ${which === 1 ? 'compare-upper' : 'compare-lower'}`,
          text: which === 1 ? '◥' : '◣',
          title: which === 1 ? 'Upper-right triangle' : 'Lower-left triangle',
        }),
        el('span', { class: 'file-name', text: `File ${which}` }),
        ...(close === undefined
          ? []
          : [
              iconButton(
                'x',
                which === 1
                  ? 'Close this file. The other takes its place and the map goes back to one.'
                  : 'Close this file and go back to one map.',
                () => close(which),
                { class: 'btn btn-icon btn-close', size: 13 },
              ),
            ]),
      ),
      this.fileTable(info),
    )
  }

  private fileTable(info: OpenResult): HTMLElement {
    const rows: Array<[string, string]> = [
      ['uri', info.uri],
      ['layout', info.layout.kind],
      ['source', info.sourceKind === 'local' ? `local file (${fmt.bytes(info.sourceBytes)})` : `remote (${fmt.bytes(info.sourceBytes)})`],
      ['bin size', info.binsize === null ? '—' : `${fmt.int(info.binsize)} bp`],
      ['bin type', String(info.info['bin-type'] ?? '—')],
      ['ordering', String(info.info['ordering'] ?? '—')],
      ['storage mode', String(info.info['storage-mode'] ?? '—')],
      ['assembly', String(info.info['assembly'] ?? '—')],
      ['format', `${String(info.info['format'] ?? '—')} v${String(info.info['format-version'] ?? '?')}`],
      // A cooler has no genome layer, and a row reading "genomes 0" invites the
      // question of where they went. It is the contigs — cooler's chroms — that
      // this file is made of.
      ...(info.hasGenomes
        ? ([['genomes', fmt.int(info.nGenomes)]] as Array<[string, string]>)
        : []),
      [info.hasGenomes ? 'contigs' : 'chromosomes', fmt.int(info.nContigs)],
      ['bins', fmt.int(info.nBins)],
      ['non-zero pixels', info.info['nnz'] === null || info.info['nnz'] === undefined ? '—' : fmt.int(Number(info.info['nnz']))],
      ['sum', info.info['sum'] === null || info.info['sum'] === undefined ? '—' : fmt.int(Number(info.info['sum']))],
    ]
    return el('div', { class: 'kv' }, ...rows.flatMap(([key, value]) => keyValue(key, value)))
  }

  /**
   * The single retained `__unbinned__` number, labelled as a QC statistic and
   * not as a genome.
   */
  private unassignedBlock(): HTMLElement | null {
    // A cooler was never binned, so there is no binning to report on — clean or
    // otherwise. Saying "every contig was assigned to a bin" about a file with
    // no bins is a false statement, not a reassuring one.
    if (!this.props.info.hasGenomes) return null
    const stats = this.props.info.unassigned
    if (stats === null) {
      return el(
        'div',
        { class: 'qc qc-clean' },
        el('h4', { class: 'qc-head', text: 'Binning QC' }),
        el('p', { text: 'This file has no __unbinned__ genome: every contig was assigned to a bin.' }),
      )
    }
    const contigFraction = stats.totalContigs === 0 ? 0 : stats.contigs / stats.totalContigs
    const binFraction = stats.totalBins === 0 ? 0 : stats.bins / stats.totalBins
    return el(
      'div',
      { class: 'qc' },
      el('h4', { class: 'qc-head', text: 'Binning QC' }),
      el('p', {
        class: 'qc-stat',
        text: `unassigned: ${fmt.int(stats.contigs)} contigs / ${fmt.pct(binFraction)} of bins`,
      }),
      el('p', {
        class: 'hint',
        text:
          `${fmt.pct(contigFraction)} of contigs and ${fmt.int(stats.bins)} of ${fmt.int(stats.totalBins)} bins ` +
          'belong to __unbinned__. Unassigned contigs are not a genome and cannot be displayed; ' +
          'this number is a diagnostic of binning quality only.',
      }),
    )
  }

  private metadataBlock(): HTMLElement {
    const metadata = this.props.info.metadata
    if (metadata === null || Object.keys(metadata).length === 0) {
      return el(
        'div',
        { class: 'meta-empty' },
        cardTitle('Metadata', 'info'),
        el('p', { class: 'hint', text: 'No metadata was stored in this file.' }),
      )
    }
    return el(
      'details',
      { class: 'meta' },
      el('summary', { text: 'Metadata' }),
      el('pre', { class: 'json', text: JSON.stringify(metadata, null, 2) }),
    )
  }


}

function keyValue(key: string, value: string): HTMLElement[] {
  return [el('div', { class: 'k', text: key }), el('div', { class: 'v', text: value, title: value })]
}
