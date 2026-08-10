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
 * two lists, two filters and two ways of saying "showing 4 of 16", and a reader
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
}

export function sequenceCard(props: SequenceCardProps): HTMLElement {
  const { contigs, selection } = props
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
        const go = el(
          'button',
          {
            class: 'seq-go',
            type: 'button',
            title: `${contig.name} — ${fmt.int(contig.length)} bp. Click to show the whole sequence.`,
          },
          el('span', { class: 'seq-name', text: contig.name }),
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
    chosen.replaceChildren(
      ...(count === 0
        ? []
        : [
            el('span', { text: `showing ${fmt.int(count)} of ${fmt.int(contigs.length)} — ` }),
            button('the whole genome', () => selection.clear(), {
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
    placeholder: `filter ${fmt.int(contigs.length)} sequences…`,
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
  sync()

  return el(
    'div',
    { class: 'card seq-card' },
    cardTitle('Sequences', 'list'),
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
