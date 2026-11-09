/**
 * The row that writes what is on screen to a file: how fine, what file, go.
 *
 * Four cards in this app save a picture or a set of marks — the contact map's
 * Export card, the 1D browser's, the 3D structure's, and the Manual card's
 * marks — and all four had built the row themselves. They drifted, in every way
 * a row of four controls can: the map offered a resolution and the structure
 * did not, the structure's two buttons were named by format and quiet while the
 * map's were bordered marks beside a format select, the browser hid its
 * resolution for one format and the map showed it for both, and only two of the
 * four had anywhere to say what had just happened. A reader who had learned to
 * export a map had to learn it again for the structure.
 *
 * So the row is one object with one shape — `[resolution] [format] [⭳] [⧉]` and
 * a line under it — and what varies is declared rather than redrawn: a card
 * with nothing to offer about resolution omits it, a card whose output is a
 * file rather than an image omits the clipboard. The marks the buttons wear
 * stay marks: `Save` and `Copy` spelled out put two words of chrome in a
 * 260-pixel column, and the words are in the tooltips where a reader who needs
 * them is already pointing.
 */

import { el } from './dom'
import { iconButton } from './icons'

/** One thing the row can write, as the select offers it. */
export interface ExportChoice {
  value: string
  /** What the option reads as — a format name in capitals, or what it writes. */
  label: string
}

export interface ExportRowOptions {
  /**
   * The resolutions to offer, in dots per inch, or nothing for a row whose
   * output has no resolution to choose.
   */
  dpi?: { choices: readonly number[]; value: number; onChange(dpi: number): void }
  formats: readonly ExportChoice[]
  /** Which format is chosen when the row is built. */
  format?: string
  onFormat?(format: string): void
  onSave(format: string, dpi: number): void
  /** Absent for a row that writes a file rather than a picture. */
  onCopy?(dpi: number): void
  formatTitle?: string
  saveTitle?: string
  copyTitle?: string
  /** Extra classes on the row, for a card that lays its controls out its own way. */
  class?: string
}

export interface ExportRow {
  /** The row itself: selects and buttons on one baseline. */
  el: HTMLElement
  /** The line under it, where what just happened is said. */
  note: HTMLElement
  /** Both together, for a card with nothing else in its body. */
  body: HTMLElement
  /** The chosen format, for a caller whose shortcut saves without the button. */
  format(): string
  /** The chosen resolution, or 96 where the row offers none. */
  dpi(): number
  /** Reach the parts a card has to enable, disable or hide itself. */
  parts: {
    dpi: HTMLSelectElement | null
    format: HTMLSelectElement
    save: HTMLButtonElement
    copy: HTMLButtonElement | null
    /** The box the save and the clipboard share, for a switch that belongs on their line. */
    acts: HTMLElement
  }
}

export function exportRow(options: ExportRowOptions): ExportRow {
  let dpiSelect: HTMLSelectElement | null = null
  if (options.dpi !== undefined) {
    const choice = options.dpi
    dpiSelect = el('select', {
      class: 'select select-dpi',
      title: 'Dots per inch of the saved figure. 96 is what is on screen; 300 is print.',
    })
    for (const dpi of choice.choices) {
      dpiSelect.appendChild(el('option', { value: String(dpi), text: `${dpi} dpi` }))
    }
    dpiSelect.value = String(choice.value)
    dpiSelect.addEventListener('change', () => choice.onChange(Number((dpiSelect as HTMLSelectElement).value)))
  }

  const formatSelect = el('select', {
    class: 'select select-format',
    ...(options.formatTitle === undefined ? {} : { title: options.formatTitle }),
  })
  for (const format of options.formats) {
    formatSelect.appendChild(el('option', { value: format.value, text: format.label }))
  }
  if (options.format !== undefined) formatSelect.value = options.format
  formatSelect.addEventListener('change', () => options.onFormat?.(formatSelect.value))

  const chosenDpi = (): number => (dpiSelect === null ? 96 : Number(dpiSelect.value))

  const save = iconButton(
    'download',
    options.saveTitle ?? 'Save what is on screen, in the format chosen beside this',
    () => options.onSave(formatSelect.value, chosenDpi()),
    { class: 'btn btn-icon', size: 15 },
  )
  // Beside the download rather than under it: they are the same figure going to
  // two places. The clipboard takes a PNG whatever the format beside it says —
  // see `KEYS.copyPlot`.
  const copy =
    options.onCopy === undefined
      ? null
      : iconButton(
          'clipboard-copy',
          options.copyTitle ?? 'Copy the figure as a PNG, ready to paste',
          () => options.onCopy?.(chosenDpi()),
          { class: 'btn btn-icon', size: 15 },
        )

  const acts = el('div', { class: 'export-acts' }, save, ...(copy === null ? [] : [copy]))
  const row = el(
    'div',
    { class: options.class === undefined ? 'export-row' : `export-row ${options.class}` },
    ...(dpiSelect === null ? [] : [dpiSelect]),
    formatSelect,
    // The two marks in one box, so a wrap cannot come *between* them. In a
    // 200-pixel column there was room for the download after the format select
    // and not for the clipboard, so the row broke into three lines with one
    // button alone on the last — which reads as an afterthought rather than as
    // the other half of a pair. They are the same figure going to two places.
    acts,
  )
  const note = el('span', { class: 'clip-note export-note' })
  return {
    el: row,
    note,
    body: el('div', { class: 'panel-controls' }, row, note),
    format: () => formatSelect.value,
    dpi: chosenDpi,
    parts: { dpi: dpiSelect, format: formatSelect, save, copy, acts },
  }
}
