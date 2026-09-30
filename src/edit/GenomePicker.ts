/**
 * Which genome of a metagenome to edit (SPECS §27.10).
 *
 * The stage is on one genome at a time: a metagenome of twenty thousand
 * contigs has no picture of the stage's kind — a cell never holds two sequences
 * — and a curator scaffolds a MAG, not a community. So the stage asks, where
 * nothing in view says which: the genomes as the file lists them, longest
 * first, each with its size, its contigs and what has been done to it, and a
 * filter for a file of hundreds. `__unbinned__` is not one of them (§7.4): a
 * contig of it is brought into a genome from that genome's stage.
 */

import { fmt } from '../units'
import { el } from '../ui/dom'
import { Modal } from '../ui/Modal'

/** A genome the picker offers. */
export interface PickableGenome {
  name: string
  /** Its length in base pairs, and how many contigs it is in. */
  length: number
  contigs: number
  /** Steps of its edit applied, where it has one. */
  steps: number
}

/**
 * Ask which genome to edit.
 *
 * @returns The genome picked, or `null` where the dialog was closed.
 */
export function pickGenome(file: string, genomes: readonly PickableGenome[]): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null
    const sorted = [...genomes].sort((a, b) => b.length - a.length || a.name.localeCompare(b.name))
    new Modal({
      title: `Edit a genome · ${file}`,
      titleIsName: true,
      variant: 'modal-genome-picker',
      body: (close) => {
        const filter = el('input', {
          class: 'input genome-picker-filter',
          attrs: { type: 'search', placeholder: 'Filter genomes', 'aria-label': 'Filter genomes', spellcheck: 'false' },
        })
        const list = el('ul', { class: 'genome-picker-list', attrs: { role: 'listbox', 'aria-label': 'Genomes' } })
        const paint = (): void => {
          const needle = filter.value.trim().toLowerCase()
          const shown = needle === '' ? sorted : sorted.filter((genome) => genome.name.toLowerCase().includes(needle))
          list.replaceChildren(
            ...shown.map((genome) =>
              el(
                'li',
                {},
                el(
                  'button',
                  {
                    class: 'genome-picker-row',
                    attrs: { type: 'button', role: 'option' },
                    title: `Edit ${genome.name}: its contigs alone, scaffolded, turned, split or moved to another genome`,
                    on: {
                      click: () => {
                        picked = genome.name
                        close()
                      },
                    },
                  },
                  el('span', { class: 'genome-picker-name', text: genome.name }),
                  el('span', { class: 'genome-picker-size', text: fmt.bp(genome.length) }),
                  el('span', { class: 'genome-picker-contigs', text: `${genome.contigs.toLocaleString('en-US')} contig${genome.contigs === 1 ? '' : 's'}` }),
                  el('span', {
                    class: 'genome-picker-steps',
                    text: genome.steps > 0 ? `edited · ${genome.steps} step${genome.steps === 1 ? '' : 's'}` : '',
                  }),
                ),
              ),
            ),
            ...(shown.length === 0 ? [el('li', { class: 'genome-picker-none', text: 'No genome by that name.' })] : []),
          )
        }
        filter.addEventListener('input', paint)
        paint()
        requestAnimationFrame(() => filter.focus())
        return el(
          'div',
          { class: 'genome-picker' },
          el('p', {
            class: 'genome-picker-note',
            text: 'The stage edits one genome at a time: its contigs alone, with contigs of other genomes brought in or sent out.',
          }),
          filter,
          list,
        )
      },
      onClose: () => resolve(picked),
    })
  })
}
