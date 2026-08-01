/**
 * The command palette (⌘P / Ctrl+P).
 *
 * Matching is subsequence, not substring: `wm` finds "whole metagenome" and
 * `ctb` finds "contigs table". That is what makes a palette faster than the
 * menu it replaces — you type the shape of the command, not its spelling.
 *
 * Disabled commands stay listed and unselectable. A palette whose contents
 * change as you navigate cannot be learned, and "why is this greyed out" is a
 * better question for a user to have than "where did it go".
 */

import { Modal } from './Modal'
import { el } from './dom'
import { keyLabel, type Command } from './commands'

/**
 * Score a command against a query. `null` means no match; lower is better.
 *
 * The score counts the *gaps* the match had to jump, so `contigs` beats `cs` on
 * "Go contigs table" even though both span the same six characters — the first
 * is the word, the second is two letters that happen to sit at its ends. An
 * exact prefix wins outright.
 */
export function scoreCommand(command: Command, query: string): number | null {
  const haystack = `${command.group} ${command.title}`.toLowerCase()
  const needle = query.trim().toLowerCase()
  if (needle === '') return 0
  if (haystack.startsWith(needle)) return -1
  let at = -1
  let first = -1
  for (const char of needle) {
    at = haystack.indexOf(char, at + 1)
    if (at < 0) return null
    if (first < 0) first = at
  }
  return at - first - (needle.length - 1)
}

export function openCommandPalette(commands: Command[], onClose?: () => void): Modal {
  let selection = 0
  let visible: Command[] = []

  const input = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Type a command…',
    attrs: { 'aria-label': 'command' },
  })
  const list = el('div', { class: 'palette-list', attrs: { role: 'listbox' } })

  const modal = new Modal({
    title: 'Commands',
    variant: 'modal-palette',
    ...(onClose === undefined ? {} : { onClose }),
    body: (close) => {
      const run = (command: Command): void => {
        if (command.enabled === false) return
        close()
        command.run()
      }

      const render = (): void => {
        const query = input.value
        visible = commands
          .map((command) => ({ command, score: scoreCommand(command, query) }))
          .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
          .sort((a, b) => a.score - b.score)
          .map((entry) => entry.command)
        if (selection >= visible.length) selection = Math.max(0, visible.length - 1)

        list.replaceChildren(
          ...(visible.length === 0
            ? [el('p', { class: 'hint', text: 'No command matches that.' })]
            : visible.map((command, index) => {
                const row = el(
                  'div',
                  {
                    class: `palette-row${index === selection ? ' selected' : ''}${
                      command.enabled === false ? ' disabled' : ''
                    }`,
                    attrs: { role: 'option', 'aria-selected': String(index === selection) },
                  },
                  el(
                    'div',
                    { class: 'palette-text' },
                    el('span', { class: 'palette-group', text: command.group }),
                    el('span', { class: 'palette-title', text: command.title }),
                    ...(command.hint === undefined
                      ? []
                      : [el('span', { class: 'palette-hint', text: command.hint })]),
                  ),
                  ...(command.keys === undefined
                    ? []
                    : [el('kbd', { class: 'kbd', text: keyLabel(command.keys) })]),
                )
                row.addEventListener('mousemove', () => {
                  if (selection === index) return
                  selection = index
                  render()
                })
                row.addEventListener('click', () => run(command))
                return row
              })),
        )
        list.querySelector('.palette-row.selected')?.scrollIntoView({ block: 'nearest' })
      }

      input.addEventListener('input', () => {
        selection = 0
        render()
      })
      input.addEventListener('keydown', (event) => {
        switch (event.key) {
          case 'ArrowDown':
            event.preventDefault()
            selection = Math.min(selection + 1, visible.length - 1)
            render()
            return
          case 'ArrowUp':
            event.preventDefault()
            selection = Math.max(selection - 1, 0)
            render()
            return
          case 'Enter': {
            event.preventDefault()
            const chosen = visible[selection]
            if (chosen !== undefined) run(chosen)
          }
        }
      })

      render()
      return el('div', { class: 'palette-body' }, input, list)
    },
  })

  return modal
}
