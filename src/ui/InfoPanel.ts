/**
 * The file info panel: attributes, metadata, the unassigned QC statistic, and
 * the performance counters.
 *
 * Three things here are specified rather than chosen.
 *
 * **The unassigned statistic (§7.4).** The fraction of contigs and bins that
 * binning failed to assign is shown once, as a read-only number, phrased as
 * `unassigned: 1,204 contigs (30.1%) · 830 bins (8.3%)`. Both quantities whole
 * on one line, because the line used to pair a count of contigs with a
 * *percentage* of bins and leave the other half of each to a paragraph under it:
 * a reader wanting either number had to assemble it from two sentences in two
 * units. It is a direct diagnostic of binning quality; a metagenomics reader
 * will look for it and a reviewer will expect it. It is a *number, not a view*:
 * it opens nothing, selects nothing, and is not a row in any table. It is the
 * sole exception to `__unbinned__` being invisible, and no code path reaches the
 * reserved genome through it — this panel receives four integers, not an index.
 *
 * **Every block here is a card** (§26.6). The QC statistic was a bare `h4` and
 * the metadata was a bare heading when empty and a `<details>` when not, which
 * made three heading shapes in one column and two of them for one block: a
 * reader comparing two files watched that strip change its typography rather
 * than fill and empty. They are cards now, with the same `cardTitle` and the
 * same fold every other card in every column has, and the stored metadata opens
 * folded because a hundred lines of JSON is not what a reader came to this
 * column for.
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
 * **The minimap host** is under it, and it is the same file's sequences drawn
 * rather than listed, with the current view marked on the strip
 * (`ui/MinimapCard.ts`). It is gated on the same fact the Sequences card is —
 * a metagenome's contigs are a texture and not a picture — and it is the one
 * card in this panel that has to be *told* things as the reader navigates, so
 * the session keeps the object and calls its own `update`.
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
import { resolutionLabel } from '../units'
import { cardTitle, foldable, icon, iconButton } from './icons'
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
   * The Genome minimap's slot, under the Sequences card.
   *
   * A host for the same reason the one above it is: the *card* is the session's
   * — it is built from the assembly and it has to be told where the reader is on
   * every navigation — while this panel only says where in the column it goes.
   * Directly under Sequences because the two answer one question between them:
   * that card is the list of sequences and this one is the picture of them, with
   * the current view marked on it (`ui/MinimapCard.ts`).
   *
   * Empty on a metagenome, and the session applies that gate with `suitsMinimap`
   * — the same rule that withholds the Sequences card and the browser's bar.
   * `.minimap-host:empty` is what keeps an absent card from spending a gap.
   */
  private readonly minimapHost = el('div', { class: 'minimap-host' })
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
      this.minimapHost,
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
   * Hang the Genome minimap under the Sequences card, or take it away.
   *
   * Called once per file, with the card the session built — and then the card is
   * *kept*: it owns a `ResizeObserver`, a text-scale subscription and a drag in
   * flight, and where the reader is arrives through its own `update`, so
   * replacing it on every navigation would throw all four away to redraw one
   * highlight. `null` withdraws it, which is what a metagenome gets
   * (`suitsMinimap`) and what a session with no assembly gets.
   */
  setMinimap(card: HTMLElement | null): void {
    this.minimapHost.replaceChildren(...(card === null ? [] : [card]))
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

  /**
   * Re-read the open file's facts.
   *
   * Almost everything on this card is fixed for the life of an open file —
   * a bin size does not change while it is open — so the panel is painted once
   * and left. One thing does: an `.scool`'s cell set, which the reader changes
   * by ticking boxes, and with it the pixel count the card reports and the whole
   * -file gate forecasts from. Left unpainted, the panel went on saying *all
   * 3,882* over a map summed from two.
   */
  refresh(info: OpenResult): void {
    this.props.info = info
    this.paintFiles()
  }

  private paintFiles(): void {
    if (this.compare === null) {
      this.fileHost.replaceChildren(
        el(
          'div',
          { class: 'card' },
          foldable(
            el(
              'h3',
              { class: 'file-head card-head' },
              icon('file', { size: 13 }),
              el('span', { class: 'file-name', text: 'File' }),
            ),
            'File',
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
      foldable(
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
        `File ${which}`,
      ),
      this.fileTable(info),
    )
  }

  private fileTable(info: OpenResult): HTMLElement {
    const rows: Array<[string, string]> = [
      ['uri', info.uri],
      ['layout', info.layout.kind],
      ['source', info.sourceKind === 'local' ? `local file (${fmt.bytes(info.sourceBytes)})` : `remote (${fmt.bytes(info.sourceBytes)})`],
      ['bin size', info.binsize === null ? '—' : resolutionLabel(info.binsize)],
      ['bin type', String(info.info['bin-type'] ?? '—')],
      ['ordering', String(info.info['ordering'] ?? '—')],
      ['storage mode', String(info.info['storage-mode'] ?? '—')],
      ['assembly', String(info.info['assembly'] ?? '—')],
      ['format', `${String(info.info['format'] ?? '—')} v${String(info.info['format-version'] ?? '?')}`],
      // A cooler has no genome layer, and a row reading "genomes 0" invites the
      // question of where they went. It is the contigs — cooler's chroms — that
      // this file is made of.
      //
      // `__unbinned__` is not one of them (§7.4, §8.5). `nGenomes` counts it,
      // because it occupies genome index 0 and every lookup downstream has to
      // know that; the genomes *table* under this card does not list it, so
      // printing the raw count put a 49th organism in a card sitting a hand's
      // width above a table saying 48 rows. The QC line below is the one place
      // it is counted.
      ...(info.hasGenomes
        ? ([
            ['genomes', fmt.int(info.nGenomes - (info.unassigned === null ? 0 : 1))],
          ] as Array<[string, string]>)
        : []),
      [info.hasGenomes ? 'contigs' : 'chromosomes', fmt.int(info.nContigs)],
      ['bins', fmt.int(info.nBins)],
      // Two rows for an scool where every other file has none: how many cells
      // it holds, and how many of them the picture on screen is made of. The
      // second is the one that matters — a map summed from four cells and a map
      // summed from four thousand look like different experiments, and this is
      // the panel that says which one is being read.
      ...(info.cells.length === 0
        ? []
        : ([
            ['cells', fmt.int(info.cells.length)],
            [
              'cells summed',
              info.activeCells.length === info.cells.length
                ? `all ${fmt.int(info.cells.length)}`
                : fmt.int(info.activeCells.length),
            ],
          ] as Array<[string, string]>)),
      // An scool's root declares no pixel count — it has no pixels of its own —
      // so the honest number is the selected cells', which is also the one the
      // whole-file gate forecasts from.
      [
        'non-zero pixels',
        info.cellNnz !== null
          ? fmt.int(info.cellNnz)
          : info.info['nnz'] === null || info.info['nnz'] === undefined
            ? '—'
            : fmt.int(Number(info.info['nnz'])),
      ],
      ['sum', info.info['sum'] === null || info.info['sum'] === undefined ? '—' : fmt.int(Number(info.info['sum']))],
    ]
    // One line a row, scrolled sideways rather than wrapped: a URI broken over
    // eight lines, and `storage mode` over two, made the card three times as
    // tall as its facts and split words a reader copies out of it.
    return el(
      'div',
      { class: 'file-scroll' },
      el('div', { class: 'kv kv-nowrap' }, ...rows.flatMap(([key, value]) => keyValue(key, value))),
    )
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
        { class: 'card qc qc-clean' },
        cardTitle('Binning QC', 'info'),
        el('p', { text: 'This file has no __unbinned__ genome: every contig was assigned to a bin.' }),
      )
    }
    const contigFraction = stats.totalContigs === 0 ? 0 : stats.contigs / stats.totalContigs
    const binFraction = stats.totalBins === 0 ? 0 : stats.bins / stats.totalBins
    return el(
      'div',
      { class: 'card qc' },
      cardTitle('Binning QC', 'info'),
      // Each quantity whole: a count, and what share of its own total that is.
      // The hint under it is one clause, because the two sentences it used to
      // carry were a disclaimer — *cannot be displayed*, *a diagnostic only* —
      // and a reader acts on neither; what they act on is the number.
      el('p', {
        class: 'qc-stat',
        text:
          `unassigned: ${fmt.int(stats.contigs)} contigs (${fmt.pct(contigFraction)}) · ` +
          `${fmt.int(stats.bins)} bins (${fmt.pct(binFraction)})`,
      }),
      el('p', {
        class: 'hint',
        text: '__unbinned__ is not a genome and is never drawn; a diagnostic of binning quality.',
      }),
    )
  }

  /**
   * What the file stored about itself, in the column's own shape.
   *
   * One card in both states, headed like every other card here, and *folded*
   * when there is JSON in it. It was two shapes before — an uppercase iconed
   * heading with a hint under it when the file stored nothing, a bare `▶
   * Metadata` disclosure when it stored something — so the absence of metadata
   * was announced more loudly than its presence, and a reader moving between a
   * cooler and a metacool saw one strip of this column change its typography.
   * Folded rather than open because this block is consulted once and then
   * ignored (see the header): the fold is the card's own, so the chevron says
   * which way it will go and one press opens it.
   */
  private metadataBlock(): HTMLElement {
    const metadata = this.props.info.metadata
    const stored = metadata !== null && Object.keys(metadata).length > 0
    const head = cardTitle('Metadata', 'info')
    const card = el(
      'div',
      { class: 'card' },
      head,
      stored
        ? el('pre', { class: 'json', text: JSON.stringify(metadata, null, 2) })
        : el('p', { class: 'hint', text: 'No metadata was stored in this file.' }),
    )
    if (stored) startFolded(card, head)
    return card
  }
}

/**
 * A card that is built already folded.
 *
 * `cardTitle` builds its chevron open, which is right for a card a reader came
 * to read; this is the one that is not. The class goes on the card and the
 * chevron is told the same thing `foldCard` tells it on every later press, so
 * the two never start out disagreeing — a chevron pointing down over a card with
 * nothing under it is a card that looks broken until it is pressed twice.
 */
function startFolded(card: HTMLElement, head: HTMLElement): void {
  card.classList.add('is-folded')
  const chevron = head.querySelector('.card-fold')
  if (!(chevron instanceof HTMLElement)) return
  chevron.setAttribute('aria-expanded', 'false')
  chevron.setAttribute('aria-label', 'Expand Metadata')
  chevron.title = 'Expand'
}

function keyValue(key: string, value: string): HTMLElement[] {
  return [
    el('div', { class: 'k', text: key }),
    // A long value **wraps** rather than being cut: the panel is where a reader
    // goes to read the identity of what is on screen whole, and the card's
    // sideways scroll was the promise this made and never kept — a URL chopped
    // at `http://127.0.0.1:5` with no ellipsis and no scrollbar drawn reads as a
    // rendering fault rather than as a long path. The `title` stays for the
    // reader who would rather hover than read three lines.
    el('div', { class: 'v', text: value, title: value }),
  ]
}
