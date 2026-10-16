/**
 * The sequence a deck cell's map is on, as a picker on the cell's heading
 * (§16.3) — and the road to another one, for that cell.
 *
 * On a companion a pick is a window of the map's own: the whole of that
 * sequence, read from its own file at its own rung, the others left where they
 * are — what a box drawn on a cell off the lead already did for a stretch of
 * one, and which had no road to *another* sequence at all, short of moving the
 * whole deck there. On the first map it is the session's own navigation, as
 * the locus box's would be, and every map following it goes along.
 *
 * Each list is the cell's own file's, in its own names: a deck can hold a
 * `chr4` beside a `4` (§5.9), and a cell lists what its reader can read.
 */

import { el } from '../ui/dom'

/**
 * The most sequences a picker lists. Past this a file's sequences are a table
 * — a metagenome's contigs, an unplaced scaffold set — and a menu of them is a
 * page nobody scrolls; such a cell keeps the box drawn on it (§16.3).
 */
export const SEQUENCE_MENU_MAX = 1000

/** The heading's picker: quiet until approached, like the rung beside it. */
export function sequencePicker(onPick: (name: string) => void): HTMLSelectElement {
  const picker = el('select', {
    class: 'select select-tiny deck-seq hidden',
    attrs: { 'aria-label': 'Sequence this map shows' },
  })
  picker.addEventListener('change', () => {
    if (picker.value !== '') onPick(picker.value)
  })
  // The heading's gestures are not the map's: a press here must not reach the
  // grip or a view below that would read it as the start of a drag.
  picker.addEventListener('pointerdown', (event) => event.stopPropagation())
  return picker
}

/**
 * What a block of these rows and columns is on, for the picker to say: the one
 * sequence, or the phrase standing in for several.
 */
export function shownSequence(rows: readonly string[], cols: readonly string[]): { name: string } | { phrase: string } {
  const across = new Set([...rows, ...cols])
  if (across.size === 1) return { name: [...across][0] }
  if (rows.length === 1 && cols.length === 1) return { phrase: `${rows[0]} × ${cols[0]}` }
  return { phrase: across.size === 0 ? '—' : `${across.size} sequences` }
}

/**
 * Fill and set the picker: `names` in the file's order, `shown` what the block
 * is on, and `title` what a pick would do there.
 *
 * Hidden where there is nothing to choose between — one sequence, or more than
 * {@link SEQUENCE_MENU_MAX}. The options are rebuilt only when the list itself
 * changed, because this runs on every read and replacing a `<select>`'s options
 * while its menu is open closes it under the pointer.
 */
export function paintSequencePicker(
  picker: HTMLSelectElement,
  names: readonly string[],
  shown: { name: string } | { phrase: string },
  title: string,
): void {
  const offer = names.length > 1 && names.length <= SEQUENCE_MENU_MAX
  picker.classList.toggle('hidden', !offer)
  if (!offer) return
  const listed = Array.from(picker.options)
    .filter((option) => option.value !== '')
    .map((option) => option.value)
  if (listed.length !== names.length || listed.some((name, i) => name !== names[i])) {
    picker.replaceChildren(
      // The phrase for a block on several sequences, in the closed box only: it
      // is not a place a pick could go to.
      el('option', { value: '', attrs: { disabled: '', hidden: '' } }),
      ...names.map((name) => el('option', { value: name, text: name })),
    )
  }
  const blank = picker.options[0]
  if ('name' in shown && names.includes(shown.name)) {
    blank.textContent = ''
    picker.value = shown.name
  } else {
    blank.textContent = 'name' in shown ? shown.name : shown.phrase
    picker.value = ''
  }
  picker.title = title
}
