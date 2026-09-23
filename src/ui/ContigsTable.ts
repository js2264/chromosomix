/**
 * The contigs table.
 *
 * Two jobs. For a plain `.cool` or `.mcool` it is *the* entry point (spec §9):
 * the synthesised genomes table is one meaningless row, so landing there would
 * be landing on nothing. For a `.metacool` it is the third breadcrumb segment —
 * the contigs of one genome, on the way to a region.
 *
 * §9 used to rule whole-genome browsing of a eukaryotic cooler out entirely, so
 * this view led to a region and to nothing else. It is not out of scope any
 * more — the whole map is read at the resolution it is drawn at, so no file is
 * too large for it — and the way there is a button in the toolbar rather than
 * only a chevron in the breadcrumb.
 */

import type { AnnotationStore } from '../annotations/store'
import { typedLocusToRegion, type Assembly } from '../genome/assembly'
import { payloadColumnIsText, type ContigsResult } from '../worker/protocol'
import { button, el, fmt } from './dom'
import { KEYS, keyedButton, withKey } from './commands'
import { SearchBox, locusPlaceholder } from './SearchBox'
import { SequenceBar, type SequenceBarProps } from './SequenceBar'
import { VirtualTable, type ColumnDef, type VirtualTableOptions } from './VirtualTable'

const CORE_ORDER = ['name', 'length']

export interface ContigsTableOptions {
  data: ContigsResult
  /** Rows to show; defaults to every contig. Used to scope to one genome. */
  rows?: number[]
  /** Columns to omit — `genome_id` is noise on a synthesised single-genome file. */
  hideColumns?: string[]
  title?: string
  hint?: string
  /**
   * What one row is called, on *this file*: a chromosome, or a contig.
   *
   * **The vocabulary follows the file** (§3.6, §9): a cooler's sequences are
   * chromosomes and a metacool's are contigs, and the crumb and this table's own
   * title have said so for as long as they have existed. The strings inside it
   * had not — the filter box said `search contig names…` and the empty state
   * `No contigs match these filters.` under a heading reading **Chromosomes**,
   * over a summary line calling them sequences. Three nouns for sixteen yeast
   * chromosomes on one screen reads as three different lists.
   *
   * Only where the surface is about the file's own table. `sequence` stays the
   * neutral word everywhere a component is shared between file kinds — the bar's
   * summary line, the Sequences card, the locus placeholders — because there the
   * word has to be true of both.
   */
  noun?: string
  /** Restores the filters, search and sort a user left behind (`state/UiMemory`). */
  persistence?: VirtualTableOptions['persistence']
  onOpenContig(name: string): void
  /**
   * Go straight to a window inside a sequence: `chrIV:1,200,000-1,210,000`.
   *
   * The door this view did not have. Everything else here opens a *whole*
   * something — a whole sequence by clicking its row, the whole file from the
   * toolbar — and on a mammalian cooler the smaller of those two is still a
   * quarter of a gigabase. A reader who knows the ten kilobases they want had to
   * open the chromosome that contains them and narrow from there, which is a
   * large read taken to reach a small one; the reader is already paying for it
   * by the time the box they need appears.
   *
   * The read itself was never the problem. `readDenseMatrix` bounds every query
   * by `bin1_offset`, so ten bins cost ten bins' worth of pixels whichever view
   * asks — the whole of what was missing is somewhere to ask from.
   */
  onOpenRegion?(region: string): void
  /**
   * The assembly this table's rows are of, where it is one — and then the plain
   * locus box above becomes the **1D browser's bar** ({@link SequenceBar}).
   *
   * Given on a cooler and withheld on a metacool, and the reason is what the
   * ruler is: sixteen chromosomes laid end to end is a picture of a genome that
   * a hand can point at, while a hundred thousand contigs from four thousand
   * independently assembled organisms is a texture — every band a fraction of a
   * pixel, no name in any of them, and a drag that names a window inside
   * whichever slice the pointer happened to land on. There the genomes table is
   * the picker, and this table is the third crumb rather than the way in.
   */
  assembly?: Assembly
  /** The feature index the bar's box searches; see {@link SequenceBarProps.store}. */
  store?: AnnotationStore
  /** Show every ticked sequence as one map — see the genomes table's twin. */
  onOpenSelection?(names: string[]): void
  /**
   * *This sequence joins its own ends* — a column of tick boxes (§8.15).
   *
   * Here rather than on the map's own card, and the move is the point. The
   * declaration is a fact about **the assembly**: which of these sequences are
   * plasmids, which is the mitochondrion, which is a bacterial chromosome. A
   * tickbox beside one open map could only ever say it about the sequence
   * already on screen, so declaring three of them meant opening three maps — and
   * there was nowhere at all to *read* which had been declared. The table that
   * lists every sequence with its length is the one place where the question is
   * asked about all of them at once.
   *
   * Absent where there is no store to write to, which is a metacool: §8.15's
   * declaration is per file and per sequence name, and a hundred thousand
   * contigs off four thousand assemblies is not a list anybody declares against.
   */
  circular?: CircularColumn
  /** The declared origins, drawn as a column after the circular one. */
  origins?: OriginColumn
  /**
   * Open the whole file at once — see {@link GenomesTableOptions.onOpenWhole}.
   *
   * Absent where there is nothing to open: this table is also the third crumb
   * of a metacool, the contigs *of one genome*, and "the whole file" is not
   * what someone reading a MAG's contigs is asking for.
   */
  onOpenWhole?(): void
}

/** The circular declaration, as the session hands it to a table. */
export interface CircularColumn {
  has(name: string): boolean
  set(name: string, on: boolean): void
  /** Tell the table when something else changed the set; returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /**
   * The junction score the first open measured for a sequence, or `undefined`
   * where it was not measured — so a tick the test made can say why (§8.15).
   */
  evidence?(name: string): number | undefined
}

/**
 * Where each sequence's replication origin is declared (§8.15), for a column
 * that shows it. Read-only in the table: the *Origin and terminus* task is what
 * fills it in, and a workspace or `--origin` carries a typed one.
 */
export interface OriginColumn {
  /** 0-based base pairs and whose word it is, or `undefined`. */
  get(name: string): { at: number; by: 'reader' | 'task' } | undefined
  subscribe(listener: () => void): () => void
}

export class ContigsTable {
  readonly el: HTMLElement
  private readonly table: VirtualTable
  private readonly locus: SearchBox | null
  private readonly bar: SequenceBar | null
  /** The circular store's listener, dropped with the table. */
  private readonly unwatch: (() => void) | null

  constructor(options: ContigsTableOptions) {
    const payload = options.data.table
    const names = payload.data['name'] as string[]
    const noun = options.noun ?? 'contig'
    const hidden = new Set(options.hideColumns ?? [])
    const ordered = [
      ...CORE_ORDER.filter((name) => payload.columns.includes(name)),
      ...payload.columns.filter((name) => !CORE_ORDER.includes(name)),
    ].filter((name) => !hidden.has(name))

    // The first column the file's creator joined in, marked so the header shows
    // where the format's own two end — the same break the record card draws.
    const firstJoined = ordered.find((name) => !CORE_ORDER.includes(name))
    const columns: ColumnDef[] = ordered.map((name) => {
      const column = payload.data[name]
      const joined = name === firstJoined ? { joined: true } : {}
      const note = CORE_ORDER.includes(name)
        ? {}
        : { title: `${name} — joined in with the file, not part of the format` }
      if (payloadColumnIsText(column)) {
        return {
          key: name,
          label: name,
          ...note,
          ...joined,
          kind: 'string',
          width: name === 'name' ? 'minmax(12rem, 1.4fr)' : 'minmax(7rem, 1fr)',
          value: (row) => (column[row] === '' ? undefined : column[row]),
        }
      }
      return {
        key: name,
        label: name,
        ...note,
        ...joined,
        kind: 'number',
        align: 'right',
        width: 'minmax(6rem, 0.7fr)',
        value: (row) => column[row],
        format: (value) =>
          typeof value !== 'number' ? '' : name === 'length' ? fmt.int(value) : fmt.num(value),
      }
    })

    // **Last, after every column the file brought.** It is the one column that is
    // not in the file — a declaration the reader makes, not a number somebody
    // measured — so it goes where a reader's own additions go rather than
    // interrupting the run of the file's own fields. Between the name and the
    // length it also pushed the length, which is the column most often read
    // beside a name, a control's width to the right.
    const circular = options.circular
    if (circular !== undefined) {
      columns.push({
        key: 'circular',
        label: 'circular',
        kind: 'string',
        width: '5.5rem',
        title:
          `Tick a ${noun} that joins its own ends — a plasmid, a mitochondrion, a bacterial ` +
          'chromosome. The map then slides past its end and back on at its beginning, a window ' +
          'may be typed across the junction, and every cis analysis measures separation the short ' +
          'way round. Nothing in a .cool can say this, so it is the reader who does.',
        // A value as well as a box, so the column sorts and the search box
        // reaches it: on a draft assembly the three declared sequences are three
        // rows in a hundred thousand.
        value: (row) => (circular.has(names[row]) ? 'circular' : undefined),
        toggle: {
          checked: (row) => circular.has(names[row]),
          onToggle: (row, on) => circular.set(names[row], on),
          title: (row) => {
            const name = names[row]
            const score = circular.evidence?.(name)
            // What the junction test measured, where it did: a tick the app made
            // says why, and an empty box beside a high score says the reader
            // chose otherwise.
            const measured =
              score === undefined || !Number.isFinite(score)
                ? ''
                : ` The contacts across its junction are ${score.toFixed(2)}× the diagonal’s at the ` +
                  'same separation — about 1 on a circle, about 0 on a line.'
            return circular.has(name)
              ? `${name} is read as a circle. Untick to read it as a line.${measured}`
              : `Read ${name} as a circle: its last bin joins its first.${measured}`
          },
        },
      })
    }

    // The origin the arms are read from, beside the circle it is on. Read-only:
    // what fills it is the Origin and terminus task, whose own table says how
    // the call was made, and a typed one arrives in a workspace or on --origin.
    const origins = options.origins
    if (origins !== undefined) {
      columns.push({
        key: 'origin',
        label: 'origin',
        kind: 'number',
        align: 'right',
        width: '7rem',
        title:
          'Where replication starts, 1-based — what the map’s arms are read from. Filled in by ' +
          'the Origin and terminus task.',
        value: (row) => {
          const held = origins.get(names[row])
          return held === undefined ? undefined : held.at + 1
        },
        format: (value) => (typeof value === 'number' ? fmt.int(value) : ''),
      })
    }

    const chooser = options.onOpenSelection
    const show = button('show selected →', () => {
      const rows = this.table.selection
      if (chooser !== undefined && rows.length > 0) chooser(rows.map((row) => names[row]))
    })
    show.disabled = true
    // No "select all" here any more. It lived in the toolbar, three controls
    // away from the rows it acted on, and it was the *only* thing in this table
    // that could not say which rows it meant — so a reader who had filtered to
    // six of them read the button, pressed it, and had no way to tell from the
    // toolbar whether they had six or every one in the file. The box in the
    // filter row says it by where it is: it sits in the gutter directly above
    // the ticks it sets, on the line the filters are on.
    const none = button('clear selection', () => this.table.clearSelection(), {
      class: 'btn btn-quiet',
      title: 'Untick everything, including rows the filters are hiding',
    })
    none.disabled = true

    this.table = new VirtualTable({
      columns,
      rows: options.rows ?? Array.from({ length: payload.length }, (_, index) => index),
      // Ticking is offered wherever showing several is: on a metacool's
      // per-genome contigs list the map of "these contigs" is the genome view
      // one crumb up, so there is nothing for a selection to add.
      ...(chooser === undefined ? {} : { selectable: true }),
      onSelect: (rows) => {
        show.disabled = rows.length === 0
        none.disabled = rows.length === 0
        // One is named, for the reason the genomes table names one: a name says
        // what is about to open and `show 1 selected →` is arithmetic.
        show.textContent =
          rows.length === 1
            ? `show ${names[rows[0]]} →`
            : rows.length > 1
              ? `show ${fmt.int(rows.length)} selected →`
              : 'show selected →'
      },
      searchKeys: ['name'],
      searchPlaceholder: `filter ${noun} names…`,
      emptyMessage: `No ${noun}s match these filters.`,
      ...(options.persistence === undefined ? {} : { persistence: options.persistence }),
      onOpen: (row) => options.onOpenContig(names[row]),
    })
    // The same set is drawn in three places — this column, the General panel's
    // list and the map — so the boxes follow the store rather than their own
    // clicks: a declaration made on one surface has to show on the other two.
    const unwatchCircular = circular === undefined ? null : circular.subscribe(() => this.table.repaint())
    const unwatchOrigins = origins === undefined ? null : origins.subscribe(() => this.table.repaint())
    this.unwatch =
      unwatchCircular === null && unwatchOrigins === null
        ? null
        : () => {
            unwatchCircular?.()
            unwatchOrigins?.()
          }
    if (chooser !== undefined) {
      this.table.addToolbarItem(none)
      this.table.addToolbarItem(show)
    }
    const whole = options.onOpenWhole
    if (whole !== undefined) {
      this.table.addToolbarItem(
        keyedButton('whole genome →', KEYS.whole, () => whole(), {
          title: withKey('Every sequence at once, as one map', KEYS.whole),
        }),
      )
    }

    // Optional on the class, always passed by the session: a table with nowhere
    // to send a locus should not grow a box that pretends otherwise, and this
    // one is mounted from two places.
    //
    // With an assembly it is the browser's whole bar — box, **go**, the switch
    // and a ruler to drag on — and without one it is the box alone, which is
    // what a metacool's per-genome contig list gets.
    const go = options.onOpenRegion
    const assembly = options.assembly
    if (go !== undefined && assembly !== undefined) {
      this.bar = new SequenceBar({
        assembly,
        ...(options.store === undefined ? {} : { store: options.store }),
        onOpenContig: (name) => options.onOpenContig(name),
        onOpenRegion: (region) => go(region),
        ...(whole === undefined ? {} : { onOpenWhole: whole }),
      })
      this.locus = null
    } else {
      this.bar = null
      this.locus =
        go === undefined
          ? null
          : new SearchBox({
              // One builder for every locus box (§26.6), with the example taken
              // from this file's own first sequence rather than from a `chrIV`
              // it may not contain.
              placeholder: locusPlaceholder({
                first: names[0],
                accepts: { sequence: true },
              }),
              title:
                `Open a window inside one ${noun} without opening the whole of it first — ` +
                `${names[0] ?? 'contig'}:1,200,001-1,210,000. Coordinates are 1-based and ` +
                'inclusive, as IGV and samtools write them. The same box the / key opens.',
              // The button every other locus box in the application has. Enter
              // has always submitted; a reader who has learnt that `go` and
              // Enter are the same thing on four surfaces found the fifth
              // offering no way to press it with a mouse (§26.6).
              go: true,
              // 1-based inclusive in, the machine form out (§26.1) — see the
              // genomes table's twin, which had the same two bases on it.
              onSubmit: (text) => {
                if (text !== '') go(typedLocusToRegion(text))
              },
            })
    }

    /**
     * **The bar replaces the heading, rather than sitting under it.**
     *
     * A title and a sentence of prose above a locus box is what a view needs
     * when the reader has to be told where they are and what the box is for.
     * With the bar there they are told both by better means: the breadcrumb says
     * which file and which table, the ruler underneath *is* the genome, and the
     * summary line beside it says how many sequences and how far. Two lines of
     * furniture between the tab strip and the one control anybody uses is two
     * lines of scrolling on every visit, spent restating what is on screen.
     *
     * The plain-box form keeps both, because there it is all the reader has: no
     * ruler, no summary, and a box whose syntax is worth a sentence.
     */
    this.el = el(
      'section',
      { class: 'view view-contigs' },
      el(
        'header',
        { class: `view-head${this.bar === null ? '' : ' view-head-bare'}` },
        ...(this.bar !== null
          ? [this.bar.el]
          : [
              el('h2', { text: options.title ?? 'Contigs' }),
              el('p', {
                class: 'hint',
                text:
                  options.hint ??
                  // **1-based and inclusive**, which is what every reader of
                  // this box already types: what they paste comes from IGV, from
                  // samtools or off this app's own map, and all three write a
                  // locus that way (§26.1). The box converts to the half-open
                  // interval the region reader and the CLI take, so the hint no
                  // longer has to teach a reader which of two bases they are in
                  // — it used to, and the two other boxes on the same screen
                  // taught the other one.
                  `Click a ${noun} to open it as a region, or name a window in the box.`,
              }),
              ...(this.locus === null ? [] : [this.locus.el]),
            ]),
      ),
      this.table.el,
    )
  }

  /** The window or a column moved; the ruler is drawn to its own width. */
  remeasure(): void {
    this.bar?.remeasure()
  }

  /**
   * The `/` key.
   *
   * The **locus** box where there is one, and the filter otherwise. `/` means
   * "where do I want to be" in every other view of this application — it is the
   * key that opens the region bar on a map and the search field in the browser —
   * and a table is not the place for it to mean something else. The filter keeps
   * its own box directly above the rows, visible and one click away, which is
   * where a reader narrowing a list is already looking.
   */
  focusSearch(): void {
    if (this.bar !== null) this.bar.focus()
    else if (this.locus !== null) this.locus.focus()
    else this.table.focusSearch()
  }

  /** Release the table's listeners and flush its pending filter state. */
  destroy(): void {
    this.unwatch?.()
    this.table.destroy()
    this.bar?.destroy()
  }
}
