/**
 * *Sequences*: every sequence of the open file, its length, and a tick beside it.
 *
 * One card, two surfaces, and the same decision behind both. In the 1D browser
 * the ticks are the **axis** — a restriction the {@link SequenceSelection}
 * applies to the assembly, so a pan cannot leave the four chromosomes that are
 * ticked. Beside a contact map the ticks are the **picture** — none is the whole
 * map, one is that chromosome's block, several are the selection view of them —
 * and the session turns a change into a navigation.
 *
 * Which is why it lives here rather than in either of them: two cards would be
 * two lists, two filters and two ways of saying "4 of 16 ticked", and a reader
 * who hid the map would meet the second one wearing the first one's clothes.
 * What differs between the surfaces is only the sentence the tick's tooltip
 * says, which is a prop.
 *
 * The bar behind each row is the length, against the longest. It costs a
 * gradient and it turns a column of numbers into the shape of an assembly:
 * sixteen bars in a staircase is a yeast, and one bar with a thousand slivers
 * under it is a draft.
 */

import type { SequenceSelection } from '../genome/selection'
import { button, el, fmt } from './dom'
import { cardTitle } from './icons'

/**
 * How many sequence rows are built at once.
 *
 * A `chrom.sizes` is as likely to be sixteen yeast chromosomes as forty thousand
 * scaffolds off an assembler, and forty thousand buttons is a second of layout
 * for a card nobody scrolled to the end of. The filter above the list is what
 * reaches the rest, which is also the faster way to reach one of sixteen.
 */
const SEQUENCE_ROWS = 300

/** Above this many, the list gets a filter box; below it, it does not need one. */
const SEQUENCES_WORTH_FILTERING = 12

/** One sequence, as this card needs it: everything else about it is elsewhere. */
export interface SequenceRow {
  name: string
  length: number
}

export interface SequenceCardProps {
  /** Every sequence, in the order the file lists them. */
  contigs: readonly SequenceRow[]
  /** The ticks, shared with whoever else reads them (§8.4). */
  selection: SequenceSelection
  /**
   * Which of them the reader has declared circular (§8.15), for the mark.
   *
   * **Read here and written in the Chromosomes table.** Two surfaces for one
   * fact, and deliberately not two controls: the table is where the assembly is
   * laid out row by row and is where the declaring is done, and this list is
   * where a reader ends up while working — so what it owes them is the answer,
   * not another box to click. A sequence that joins its own ends is read
   * differently by the map and by every cis analysis, and until the mark was
   * here nothing on screen said which ones were.
   */
  circular?: { has(name: string): boolean; subscribe(listener: () => void): () => void }
  /** A click on the name — go there, in whatever sense the surface means. */
  onGoTo(name: string): void
  /**
   * What ticking one is *for*, in this surface's words.
   *
   * The one sentence that genuinely differs between a browser and a map, so it
   * is asked for rather than guessed: "makes it the axis" is a lie beside a
   * heatmap, and "draws its block" is a lie beside a browser.
   */
  tickTitle(name: string): string
  /** The tooltip on the *whole genome* button under the list. */
  clearTitle: string
  /**
   * What the list is called, and what its rows are — `Sequences` of a cooler;
   * `Genomes`, or one genome's `Contigs`, of a metagenome (§5.8).
   */
  title?: string
  /** The rows' plural, for the filter box: `sequences`, `genomes`, `contigs`. */
  noun?: string
  /** The button under the list that unticks everything, in this list's words. */
  clearLabel?: string
  /** The tooltip on a row's name, where *show the whole sequence* is not what a click does. */
  goTitle?(row: SequenceRow): string
  /**
   * The same rows in another order, each time the reader moves a genome or a
   * contig (§7.6). Put in place in this card rather than a new one, so the
   * filter being typed, the scroll and the ticks stay as they were.
   */
  reordered?: { subscribe(listener: (rows: readonly SequenceRow[]) => void): () => void }
  /**
   * Nodes between the title and the list: the map's **level** (§7.3), and on a
   * metagenome the line saying whose contigs these are. Held by the caller, so
   * the level can change with the view without the list being rebuilt.
   */
  head?: readonly HTMLElement[]
}

export function sequenceCard(props: SequenceCardProps): HTMLElement {
  const { selection } = props
  let contigs = props.contigs
  const list = el('div', { class: 'seq-list' })
  const note = el('p', { class: 'hint seq-note' })
  const chosen = el('p', { class: 'hint seq-chosen' })
  const longest = contigs.reduce((most, contig) => Math.max(most, contig.length), 1)

  const paint = (query: string): void => {
    const wanted = query.trim().toLowerCase()
    const matching =
      wanted === ''
        ? contigs
        : contigs.filter((contig) => contig.name.toLowerCase().includes(wanted))
    const shown = matching.slice(0, SEQUENCE_ROWS)
    list.replaceChildren(
      ...shown.map((contig) => {
        // A tick and a button, not a button containing a tick: a checkbox inside
        // a `<button>` is a control inside a control, which no browser resolves
        // the same way and none of them make keyboard-reachable.
        const tick = el('input', {
          class: 'checkbox seq-tick',
          type: 'checkbox',
          title: props.tickTitle(contig.name),
          attrs: { 'data-seq': contig.name },
        })
        tick.checked = selection.has(contig.name)
        tick.addEventListener('change', () => selection.toggle(contig.name, tick.checked))
        // The mark rides **inside the name**, not in a column of its own: a
        // fourth column on a row this narrow is a column of mostly nothing, and
        // what a reader is doing here is reading names. `↻` and a title beside
        // it, because a glyph alone is a puzzle and a word would be as long as
        // the names it follows.
        const round = props.circular?.has(contig.name) === true
        const go = el(
          'button',
          {
            class: 'seq-go',
            type: 'button',
            title:
              props.goTitle?.(contig) ??
              `${contig.name} — ${fmt.int(contig.length)} bp` +
                (round ? ', read as a circle (declared in the Chromosomes table)' : '') +
                '. Click to show the whole sequence.',
          },
          el(
            'span',
            { class: 'seq-name' },
            el('span', { text: contig.name }),
            ...(round
              ? [
                  el('span', {
                    class: 'seq-circular',
                    text: '↻',
                    attrs: { 'aria-label': 'circular' },
                  }),
                ]
              : []),
          ),
          el('span', { class: 'seq-len', text: fmt.bp(contig.length) }),
        )
        go.addEventListener('click', () => props.onGoTo(contig.name))
        const row = el('div', { class: 'seq-row' }, tick, go)
        row.style.setProperty('--seq-share', `${(contig.length / longest) * 100}%`)
        return row
      }),
    )
    note.textContent =
      matching.length > shown.length
        ? `${fmt.int(shown.length)} of ${fmt.int(matching.length)} — narrow the filter to reach the rest`
        : matching.length === 0
          ? 'nothing by that name'
          : ''
    note.classList.toggle('hidden', note.textContent === '')
  }

  /**
   * Bring the ticks and the line above them back in step with the selection.
   *
   * Needed because this card is not the only thing that writes to it: going to a
   * sequence that is not on the axis ticks it (`SequenceSelection.ensure`), a
   * navigation beside a map re-ticks whatever the new picture is of, and a tick
   * that appears in the model and not in the box is the one state this card must
   * never be in.
   */
  const sync = (): void => {
    for (const box of list.querySelectorAll<HTMLInputElement>('.seq-tick')) {
      const on = selection.has(box.dataset.seq ?? '')
      box.checked = on
      box.closest('.seq-row')?.classList.toggle('is-on', on)
    }
    const count = selection.names.length
    // **`ticked`, not `showing`.** Under a list of sixteen rows of which nine are
    // on screen, "showing 1 of 16" is read as a count of the list and sends the
    // reader looking for the other fifteen; and beside a map framed on 400 kb of
    // chromosome IV it contradicts the crumb outright. What the number is about
    // is the boxes, so it says so. The button after it is a verb, because a link
    // that read "the whole genome" was the object of the sentence in front of it
    // rather than something to press.
    chosen.replaceChildren(
      ...(count === 0
        ? []
        : [
            el('span', { text: `${fmt.int(count)} of ${fmt.int(contigs.length)} ticked · ` }),
            button(props.clearLabel ?? 'show the whole genome', () => selection.clear(), {
              class: 'seq-all',
              title: props.clearTitle,
            }),
          ]),
    )
    chosen.classList.toggle('hidden', count === 0)
  }

  const filter = el('input', {
    class: 'input input-tiny seq-filter',
    type: 'search',
    placeholder: `filter ${fmt.int(contigs.length)} ${props.noun ?? 'sequences'}…`,
  })
  filter.addEventListener('input', () => {
    paint(filter.value)
    sync()
  })
  paint('')

  const off = selection.subscribe(() => {
    // The card is replaced wholesale when the assembly's lengths are (see
    // `adoptSizes`), and nothing hands a detached one a teardown. It
    // unsubscribes itself the first time it is spoken to after leaving the
    // document, which is as long as a listener on a dead card can survive.
    if (!list.isConnected) {
      off()
      return
    }
    sync()
  })
  // A declaration made in the Chromosomes table has to reach the mark here, and
  // it is a **repaint** rather than a sync: the ring is drawn into the row's
  // name and `sync` only moves ticks. Same self-teardown as above.
  const offRound = props.circular?.subscribe(() => {
    if (!list.isConnected) {
      offRound?.()
      return
    }
    paint(filter.value)
    sync()
  })
  // Another order is a repaint of the same card, on the same self-teardown.
  const offOrder = props.reordered?.subscribe((rows) => {
    if (!list.isConnected) {
      offOrder?.()
      return
    }
    contigs = rows
    paint(filter.value)
    sync()
  })
  sync()

  return el(
    'div',
    { class: 'card seq-card' },
    cardTitle(props.title ?? 'Sequences', 'list'),
    ...(props.head ?? []),
    ...(contigs.length > SEQUENCES_WORTH_FILTERING ? [filter] : []),
    list,
    chosen,
    note,
  )
}

/** The tick tooltips the 1D browser's copy of this card wears. */
export const BROWSER_TICKS = {
  tickTitle: (name: string): string =>
    'Show only the ticked sequences. With none ticked the whole genome is one axis; ' +
    `ticking ${name} makes it the axis, so a pan cannot leave it.`,
  clearTitle: 'Untick every sequence, which puts the whole assembly back on one axis',
}

/** …and the ones it wears beside a contact map, where a tick is the picture. */
export const MAP_TICKS = {
  tickTitle: (name: string): string =>
    `Draw the ticked sequences. With none ticked the map is the whole genome; ticking ${name} ` +
    'alone draws its block, and ticking several draws those sequences against each other.',
  clearTitle: 'Untick every sequence, which puts the whole genome back on the map',
}

/** A metagenome's list of genomes: a tick draws them together, a name opens one. */
export const GENOME_TICKS = {
  tickTitle: (name: string): string => `Draw the ticked genomes together — tick ${name} to add it.`,
  clearTitle: 'Untick every genome: the whole metagenome',
  title: 'Genomes',
  noun: 'genomes',
  clearLabel: 'show the whole metagenome',
  goTitle: (row: { name: string; length: number }): string =>
    `${row.name} — ${fmt.int(row.length)} bp. Click to open it and list its contigs.`,
}

/** …and one genome's contigs, where none ticked is the genome itself. */
export const CONTIG_TICKS = {
  tickTitle: (name: string): string => `Draw the ticked contigs together — tick ${name} to add it.`,
  clearTitle: 'Untick every contig: the whole genome',
  title: 'Contigs',
  noun: 'contigs',
  clearLabel: 'show the whole genome',
}
