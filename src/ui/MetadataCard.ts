/**
 * The **Metadata** card (§8.12): the file's own columns, as lanes.
 *
 * It is the only card in the Annotations column whose contents were not loaded,
 * computed or drawn by anybody. A `.metacool` carries a `/genomes` table with
 * completeness and contamination in it, a `/contigs` table with whatever the
 * assembler and the annotator joined on, and — like every cooler — a `/bins`
 * table with at least the balancing weight. Until this card those were readable
 * only as tables, in a view that is not the picture, one row at a time.
 *
 * **What the drop-down offers is what this view can honestly show.** That is the
 * one idea worth understanding here, and it is not a refinement: the axis of a
 * genome × genome overview is MAGs, so a bin weight has nothing to say about a
 * cell that is forty thousand bins, while a MAG's contamination has something
 * exact to say about every cell of every view there is. So the list is filtered
 * by the level of the picture on screen ({@link showsAtLevel}), and the columns
 * a coarser view cannot show are listed *disabled with the reason* rather than
 * quietly left out — a control that silently holds back half its options is one
 * a reader concludes is broken.
 *
 * Everything after "add" is deliberately the machinery a track already goes
 * through. A metadata column becomes an ordinary {@link AnnotationStore} entry,
 * so the colour, the rename, the four edges, the multi-map placement, the
 * reorder, the height, the limits, the hairline, the tooltip, the figure export
 * and the session memory are the one implementation those rows already have —
 * exactly the argument `ui/synthetic.ts` makes for computed tracks (§18.5).
 * What is left for a card of its own is the drop-down, the provenance line, and
 * a TSV export of the column as the file wrote it.
 */

import type { AnnotationStore } from '../annotations/store'
import type { AnnotationEntry } from '../annotations/types'
import type { MetadataIndex } from '../annotations/metaIndex'
import {
  META_TABLES,
  metadataEntry,
  metadataId,
  originOf,
  showsAtLevel,
  summaryOf,
  type MetaColumn,
  type MetaLevel,
  type MetaTable,
} from '../annotations/metadata'
import { CATEGORY_PALETTE, categoryColour } from '../render/meta'
import { button, el } from './dom'
import { cardTitle, iconButton, startFolded } from './icons'
import { mapsOrLead, placementField } from './lanePlacement'
import { flipButton, heightField, limitsField, styleFields } from './laneSettings'

/** What each table's columns are called in the drop-down's headings. */
const TABLE_LABELS: Record<MetaTable, string> = {
  genomes: 'genomes',
  contigs: 'contigs',
  bins: 'bins',
}

/** What a cell of each level is, for the sentence that explains a refusal. */
const LEVEL_LABELS: Record<MetaLevel, string> = {
  genome: 'one genome',
  contig: 'one sequence',
  bin: 'one bin',
}

export interface MetadataCardOptions {
  store: AnnotationStore
  /** The open file's tables; `null` before they have been read. */
  index(): MetadataIndex | null
  /**
   * What one cell of the picture on screen is.
   *
   * A function rather than a value because the card is built once per file and
   * the view under it is rebuilt on every navigation — a level captured here
   * would be the level of a picture the reader left ten clicks ago. `null`
   * while nothing is mounted, which disables the drop-down rather than
   * offering every column with no way to know which of them would draw.
   */
  level(): MetaLevel | null
  /** Every map a lane may be drawn on, named — the deck's list, or absent. */
  maps?(): Array<{ id: string; label: string }>
  /** Write one column out as a TSV. */
  onExport(entry: AnnotationEntry): void
}

export class MetadataCard {
  readonly el: HTMLElement
  private readonly list = el('div', { class: 'ann-list' })
  private readonly picker = el('select', { class: 'select' })
  private readonly note = el('p', { class: 'ann-note' })
  private readonly unsubscribe: () => void
  /** A rebuild that arrived while a control on a row was being edited. */
  private pending = false

  constructor(private readonly options: MetadataCardOptions) {
    // **Folded until it is asked for** (§8.12). It sits at the foot of the
    // column, under the marks, and what it offers — a column of the file's own
    // tables drawn as a lane — is reached for on purpose rather than scanned
    // past on the way to a track, so its heading is the whole of what it costs
    // until then.
    this.el = startFolded(
      el(
        'section',
        { class: 'card annotation-card metadata-card' },
        cardTitle('Metadata annotations', 'table'),
        el(
          'div',
          { class: 'ann-inline meta-add' },
          this.picker,
          button('add', () => this.add(), {
            class: 'btn',
            title: 'Draw this column beside the map, as a lane like any other.',
          }),
        ),
        this.note,
        this.list,
      ),
    )
    this.picker.title =
      'Columns this file carries about its own genomes, sequences and bins. What is offered is ' +
      'what the view on screen can show: a column is drawn where its own table is no finer than ' +
      'the axis.'

    this.list.addEventListener('focusout', () => {
      setTimeout(() => {
        if (this.pending) this.refresh()
      }, 0)
    })
    this.unsubscribe = this.options.store.subscribe(() => this.refresh())
    this.refresh()
  }

  destroy(): void {
    this.unsubscribe()
  }

  /**
   * Rebuild the drop-down and the rows, and take the whole card away when the
   * file carries no metadata at all.
   *
   * Hidden rather than shown empty: a heading over a sentence about a feature
   * this file cannot have is noise in a column a reader is scanning.
   */
  refresh(): void {
    if (this.holdsFocus()) {
      this.pending = true
      return
    }
    this.pending = false

    const index = this.options.index()
    const columns = index?.columns ?? []
    this.el.classList.toggle('hidden', columns.length === 0)
    this.fillPicker(columns)
    const rows = this.options.store.forCard('metadata')
    this.list.replaceChildren(...rows.map((entry) => this.row(entry)))
  }

  /** `true` while a control on a row holds a value the reader has not finished
   * giving — the colour picker mid-drag, a half-typed name. */
  private holdsFocus(): boolean {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !this.list.contains(active)) return false
    return active instanceof HTMLInputElement || active instanceof HTMLSelectElement
  }

  // -------------------------------------------------------------------------
  // Adding one
  // -------------------------------------------------------------------------

  /**
   * The columns this file carries, grouped by the table they come from.
   *
   * Grouped rather than flat because the group is the answer to "how coarse is
   * this": every column under `genomes` is one value per MAG, and that is what
   * decides where it can be drawn. Already-added columns keep their place in
   * the list, marked, rather than disappearing from it — a reader looking for
   * `contamination` and not finding it has no way to tell whether they added it
   * or imagined it.
   */
  private fillPicker(columns: readonly MetaColumn[]): void {
    const held = this.picker.value
    const level = this.options.level()
    this.picker.replaceChildren()
    let offered = 0
    let refused = 0
    for (const table of META_TABLES) {
      const mine = columns.filter((column) => column.table === table)
      if (mine.length === 0) continue
      const group = el('optgroup')
      group.label = TABLE_LABELS[table]
      const shows = level === null || showsAtLevel(table, level)
      for (const column of mine) {
        const already = this.options.store.byId(metadataId(column.table, column.column)) !== undefined
        const option = el('option', {
          value: `${column.table}/${column.column}`,
          text: `${column.column}${already ? ' — added' : ''}${
            column.kind === 'qualitative' ? ' ·' : ''
          }`,
        })
        // Disabled with the reason, never left out. The reason is about the
        // *picture*, not about the column, and a reader who reads it learns
        // where to go to draw the thing they came for.
        option.disabled = !shows || already
        if (!shows) refused++
        else if (!already) offered++
        group.appendChild(option)
      }
      this.picker.appendChild(group)
    }
    // The reader's own choice survives the rebuild, where it is still offered:
    // the list is refilled on every store change and on every navigation, and a
    // picker that jumped back to its first entry each time would be one nobody
    // could aim.
    const kept = [...this.picker.options].some(
      (option) => option.value === held && !option.disabled,
    )
    if (kept) this.picker.value = held
    const shownLevel = level === null ? null : LEVEL_LABELS[level]
    this.picker.disabled = offered === 0
    // **The level is said only when it refuses something.** With nothing out of
    // reach the note read `a cell of this view is one bin` — a true sentence
    // with no consequence, under an add row, on every bin-level view: the
    // reader is told the rule that governs a refusal that is not happening and
    // is left looking for what it wants of them. LEVEL_LABELS exists for the
    // sentence that explains a refusal (§8.12), and that is where it stays.
    this.note.textContent =
      columns.length === 0
        ? ''
        : shownLevel === null
          ? 'open a map to draw one of these beside it'
          : refused === 0
            ? ''
            : `a cell of this view is ${shownLevel}, so ${refused} finer ${
                refused === 1 ? 'column is' : 'columns are'
              } out of reach here`
  }

  /**
   * Put the chosen column on the map.
   *
   * The id is derived from the table and the column
   * ({@link import('../annotations/metadata').metadataId}), so adding the same
   * one twice lands on the row that is already there rather than stacking a
   * second identical lane beside it.
   */
  private add(): void {
    const index = this.options.index()
    const chosen = this.picker.value
    if (index === null || chosen === '') return
    const cut = chosen.indexOf('/')
    const column = index.columnFor(chosen.slice(0, cut) as MetaTable, chosen.slice(cut + 1))
    if (column === null) return
    const entry = metadataEntry(column, this.options.store.nextColour())
    this.options.store.begin({
      card: 'metadata',
      kind: entry.kind,
      source: entry.source,
      id: entry.id,
      label: entry.label,
      placement: entry.placement,
      style: entry.style,
    })
    this.options.store.update(entry.id, { status: 'ready', summary: summaryOf(column) })
  }

  // -------------------------------------------------------------------------
  // The rows
  // -------------------------------------------------------------------------

  private row(entry: AnnotationEntry): HTMLElement {
    const index = this.options.index()
    const source = entry.source.kind === 'metadata' ? entry.source : null
    const column = source === null ? null : index?.columnFor(source.table, source.column) ?? null
    const row = el('div', {
      class: `ann-row ann-${entry.status}`,
      attrs: { 'data-id': entry.id },
    })
    row.appendChild(
      el(
        'div',
        { class: 'ann-head' },
        // A quantitative column is drawn in one colour and gets the picker; a
        // qualitative one is drawn in the categories' own colours and gets the
        // legend instead. One swatch cannot describe six categories, and a
        // picker that changed nothing would be the card lying about the lane.
        entry.kind === 'metadata' ? this.swatch(entry) : this.legendChip(column),
        this.name(entry),
        this.visibility(entry),
        iconButton('x', 'Take this column off the map', () => this.options.store.remove(entry.id), {
          class: 'btn-close',
          size: 14,
        }),
      ),
    )

    if (column === null && source !== null) {
      // The file changed under a restored session: the row names a column this
      // map does not have. Said plainly and left in the list, because the row
      // costs nothing and removing it silently would be this app editing a
      // reader's panel behind them.
      row.appendChild(
        el('p', {
          class: 'ann-note ann-detached',
          text: `this map has no ${originOf(source.table, source.column)} column`,
        }),
      )
      return row
    }

    if (column !== null) {
      const level = this.options.level()
      row.appendChild(el('p', { class: 'ann-note', text: summaryOf(column) }))
      if (level !== null && !showsAtLevel(column.table, level)) {
        row.appendChild(
          el('p', {
            class: 'ann-note ann-detached',
            text: `not drawn here — a cell of this view is ${LEVEL_LABELS[level]}`,
          }),
        )
      }
      const failed = index?.errorFor(column.table, column.column) ?? null
      if (failed !== null) {
        row.appendChild(el('p', { class: 'ann-note ann-detached', text: failed }))
      }
      if (column.kind === 'qualitative') row.appendChild(this.legend(column))
    }

    row.appendChild(
      el('div', { class: 'ann-inline' }, heightField(this.options.store, entry), ...
        (entry.kind === 'metadata'
          ? [...styleFields(this.options.store, entry), flipButton(this.options.store, entry)]
          : [])),
    )
    if (entry.kind === 'metadata') row.appendChild(limitsField(this.options.store, entry))
    row.appendChild(placementField(this.options.store, entry, mapsOrLead(this.options.maps)))
    if (source !== null) {
      const origin = originOf(source.table, source.column)
      row.appendChild(el('p', { class: 'ann-origin', text: origin, title: origin }))
    }
    row.appendChild(this.exportRow(entry))
    return row
  }

  /** The colour, as the picker itself — the Tracks card's swatch, same call. */
  private swatch(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'ann-swatch',
      type: 'color',
      value: entry.style.colour,
      title: `Colour for ${entry.label}`,
    })
    input.addEventListener('input', () =>
      this.options.store.restyle(entry.id, { colour: input.value }),
    )
    return input
  }

  /**
   * A categorical row's stand-in for the swatch: the first few of its colours.
   *
   * In the swatch's own place, so the head keeps its shape down the list, and
   * unclickable because there is nothing here to choose — the palette is fixed
   * so that a category means the same colour in every lane and every figure
   * (`render/meta.ts`).
   */
  private legendChip(column: MetaColumn | null): HTMLElement {
    const levels = column?.levels ?? []
    const chip = el('span', {
      class: 'meta-chip',
      title:
        levels.length === 0
          ? 'a categorical column'
          : `${levels.length} categories: ${levels.slice(0, 8).join(', ')}${levels.length > 8 ? '…' : ''}`,
    })
    for (let code = 0; code < Math.min(levels.length || 3, 4); code++) {
      const swatch = el('span', { class: 'meta-chip-part' })
      swatch.style.background = categoryColour(code)
      chip.appendChild(swatch)
    }
    return chip
  }

  /**
   * Every category, named and coloured — the legend the lane cannot carry.
   *
   * The lane writes a category's name into the runs wide enough to hold it and
   * the readout names the one under the pointer, and neither of those is a
   * legend: a reader looking at eleven stripes needs the list. Capped, because
   * past the palette's length the colours repeat and a legend that shows two
   * `plasmid`-coloured rows without saying why is worse than one that stops.
   */
  private legend(column: MetaColumn): HTMLElement {
    const levels = column.levels ?? []
    const shown = levels.slice(0, CATEGORY_PALETTE.length)
    const items = shown.map((name, code) => {
      const swatch = el('span', { class: 'meta-legend-swatch' })
      swatch.style.background = categoryColour(code)
      return el('span', { class: 'meta-legend-item', title: name }, swatch, el('span', { text: name }))
    })
    return el(
      'div',
      { class: 'meta-legend' },
      ...items,
      ...(levels.length > shown.length
        ? [
            el('span', {
              class: 'meta-legend-more',
              text: `+${levels.length - shown.length} more, in repeated colours`,
            }),
          ]
        : []),
    )
  }

  /** What the lane is called, editable in place — the synthetic card's control. */
  private name(entry: AnnotationEntry): HTMLElement {
    const input = el('input', {
      class: 'input ann-name',
      type: 'text',
      value: entry.label,
      title: `${entry.label} — click to rename`,
    })
    input.addEventListener('change', () => {
      const label = input.value.trim()
      if (label === '' || label === entry.label) {
        input.value = entry.label
        return
      }
      this.options.store.update(entry.id, { label })
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        input.blur()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        input.value = entry.label
        input.blur()
      }
    })
    return input
  }

  private visibility(entry: AnnotationEntry): HTMLElement {
    const node = iconButton(
      entry.visible ? 'eye' : 'eye-off',
      entry.visible ? 'Hide, keeping the settings' : 'Show again',
      () => this.options.store.update(entry.id, { visible: !entry.visible }),
      { class: 'btn btn-icon ann-eye', size: 14 },
    )
    node.setAttribute('aria-pressed', String(entry.visible))
    return node
  }

  /**
   * The column as a TSV — one row per unit, under a header naming both.
   *
   * The same argument §18.7 makes for a computed track, one step further back:
   * a figure with a metadata lane in it is a claim about the file's own table,
   * and the reader of that figure should be able to get the table. It is also
   * what makes the *level rule* checkable — the export writes the column at its
   * own granularity, never at the picture's.
   */
  private exportRow(entry: AnnotationEntry): HTMLElement {
    return el(
      'div',
      { class: 'ann-inline' },
      el('span', { class: 'field-label', text: 'export' }),
      // Bordered, like every other action in the app: a quiet button beside
      // bordered ones reads as a lesser kind of control, and writing the column
      // out is not a lesser thing to do than anything else on this row (§26.6).
      button('TSV', () => this.options.onExport(entry), {
        class: 'btn',
        title: 'The column as the file wrote it: one row per unit, named, under a ‘#’ header.',
      }),
    )
  }
}

