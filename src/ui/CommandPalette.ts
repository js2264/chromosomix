/**
 * The command palette (⌘P / Ctrl+P).
 *
 * Matching takes a subsequence and not only a substring: `wm` finds "whole
 * metagenome" and `ctb` finds "contigs table". That is what makes a palette
 * faster than the menu it replaces — you type the shape of the command, not its
 * spelling — and a whole word still wins over a shape, because a reader who
 * types a word they can see on screen is naming a command rather than sketching
 * one ({@link scoreCommand}).
 *
 * Disabled commands stay listed and unselectable. A palette whose contents
 * change as you navigate cannot be learned, and "why is this greyed out" is a
 * better question for a user to have than "where did it go".
 */

import { Modal } from './Modal'
import { el } from './dom'
import { groupRank, keyCap, stateChip, type Command } from './commands'

/**
 * Score a command against a query. `null` means no match; lower is better.
 *
 * The score counts the *gaps* the match had to jump, so `contigs` beats `cs` on
 * "Contigs table" even though both span the same six characters — the first is
 * the word, the second is two letters that happen to sit at its ends. A prefix
 * wins outright and a whole word inside the title comes next, because a reader
 * who types a word they can see on screen is not typing the shape of a
 * command: they are naming one, and the one they named has to be first.
 *
 * ## The title, and the group as a leading word
 *
 * The haystack used to be `${group} ${title}`, which let the group's letters
 * take part in any match: `fold` reached *File · Copy this plot to the
 * clipboard* through the F of FILE, and a row with no visible relation to the
 * word typed reads as a bug about the rows beside it. So the title is what is
 * matched, and the group is a **leading word** only — `file copy` still finds
 * it, and typing a group's name or the start of one still lists that group.
 *
 * ## Every anchor, not the first
 *
 * The subsequence used to start at the *first* occurrence of the needle's first
 * letter, so a first letter that happens to appear early — in another word, or
 * in the group — stretched the span across the whole title: `folder` anchored on
 * the F of FILE and scored 25 against the command whose name it is, where *Fold
 * or show the General panel* scored 16 and won the list. The match is tried from
 * every occurrence and the tightest span kept, which is what the gap count was
 * always meant to measure.
 */
export function scoreCommand(command: Command, query: string): number | null {
  const needle = query.trim().toLowerCase()
  if (needle === '') return 0
  const title = command.title.toLowerCase()
  const direct = scoreTitle(title, needle)
  const rest = afterGroupWord(needle, command.group.toLowerCase())
  if (rest === null) return direct
  // The group named and nothing after it: every command in it matches, above
  // the scattered-letter matches and below a command the letters actually name.
  if (rest === '') return direct === null ? 0 : Math.min(direct, 0)
  const scored = scoreTitle(title, rest)
  if (direct === null) return scored
  if (scored === null) return direct
  return Math.min(direct, scored)
}

/**
 * The needle with its leading group word taken off, or `null` where it has none.
 *
 * `''` where the group is the whole of it (`help`, or `f` for File), which is a
 * match on every command in that group rather than on a title.
 */
function afterGroupWord(needle: string, group: string): string | null {
  const space = needle.indexOf(' ')
  const head = space < 0 ? needle : needle.slice(0, space)
  if (head === '' || !group.startsWith(head)) return null
  return space < 0 ? '' : needle.slice(space + 1).trim()
}

/** A prefix, then a whole substring, then the tightest subsequence. */
function scoreTitle(title: string, needle: string): number | null {
  if (title.startsWith(needle)) return -1
  if (title.includes(needle)) return -0.5
  const chars = [...needle]
  const first = chars[0]
  if (first === undefined) return 0
  let best: number | null = null
  for (let start = title.indexOf(first); start >= 0; start = title.indexOf(first, start + 1)) {
    let at = start
    let ok = true
    for (const char of chars.slice(1)) {
      at = title.indexOf(char, at + 1)
      if (at < 0) {
        ok = false
        break
      }
    }
    // A later anchor can only push every following letter later, so a match
    // that fails from here fails from every anchor after it.
    if (!ok) break
    const span = at - start - (chars.length - 1)
    if (best === null || span < best) best = span
  }
  return best
}

export function openCommandPalette(commands: Command[], onClose?: () => void): Modal {
  let selection = 0
  let visible: Command[] = []
  // "Search commands" is the command that opened this, and a palette that
  // offers to open the palette is the one row in it that cannot mean anything.
  const offered = commands.filter((command) => command.id !== 'palette')

  // The words the header's own field and the command that opens this both use.
  // The box said *Type a command…* under a title reading *Commands*, opened
  // from a field reading *Search commands…*: three names for one box, two of
  // them on screen at once.
  const input = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'Search commands…',
    attrs: { 'aria-label': 'search commands' },
  })
  const list = el('div', { class: 'palette-list', attrs: { role: 'listbox' } })

  const modal = new Modal({
    title: 'Search commands',
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
        visible = offered
          .map((command) => ({ command, score: scoreCommand(command, query) }))
          .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
          // With nothing typed every score is 0, and `sort` on equal keys left
          // the list in registry order — App's two commands, then File's nine,
          // then whatever the session had appended since. Unqueried, the list is
          // the reference table and is printed in the reference order; once
          // something is typed, the match is what the reader is looking at and
          // the group is only the tie-break.
          .sort((a, b) => a.score - b.score || groupRank(a.command.group) - groupRank(b.command.group))
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
                  ...stateChip(command),
                  ...(command.keys === undefined
                    ? []
                    : [el('kbd', { class: 'kbd' }, ...keyCap(command.keys))]),
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
