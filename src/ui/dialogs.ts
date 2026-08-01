/**
 * The two reference dialogs: keyboard shortcuts, and what this page is.
 *
 * Both are built from data that lives elsewhere — the command registry, and the
 * heatmap's own key handling — rather than from a prose list that has to be
 * remembered when either changes. The heatmap keys are the one hand-written
 * table here, because they belong to the canvas and are not commands; they are
 * kept next to a pointer at the function that implements them.
 */

import { Modal } from './Modal'
import { el } from './dom'
import { keyLabel, type Command } from './commands'

/** `render/heatmap.ts` → `handleKeyDown` and `attach`. Keep in step with them. */
const CANVAS_KEYS: Array<[string, string]> = [
  ['drag', 'Select a region and zoom into it'],
  ['⌘ / Ctrl + drag', 'Pan'],
  ['wheel', 'Zoom about the pointer'],
  ['click', 'Open what the cell refers to'],
  ['← ↑ → ↓', 'Pan by a tenth of the view (half a view with Shift)'],
  ['+ / −', 'Zoom about the centre'],
  ['0 or Home', 'Fit the block to the canvas'],
]

function keyRow(keys: string, description: string): HTMLElement {
  return el(
    'div',
    { class: 'shortcut-row' },
    el('kbd', { class: 'kbd', text: keys }),
    el('span', { class: 'shortcut-text', text: description }),
  )
}

export function openShortcuts(commands: Command[], onClose?: () => void): Modal {
  return new Modal({
    title: 'Keyboard shortcuts',
    variant: 'modal-wide',
    ...(onClose === undefined ? {} : { onClose }),
    body: () => {
      const bound = commands.filter((command) => command.keys !== undefined)
      const groups = new Map<string, Command[]>()
      for (const command of bound) {
        const list = groups.get(command.group) ?? []
        list.push(command)
        groups.set(command.group, list)
      }
      return el(
        'div',
        { class: 'shortcut-body' },
        ...[...groups].map(([group, list]) =>
          el(
            'section',
            { class: 'shortcut-group' },
            el('h3', { text: group }),
            ...list.map((command) => keyRow(keyLabel(command.keys ?? ''), command.title)),
          ),
        ),
        el(
          'section',
          { class: 'shortcut-group' },
          el('h3', { text: 'Heatmap' }),
          ...CANVAS_KEYS.map(([keys, text]) => keyRow(keys, text)),
        ),
      )
    },
  })
}

export function openAbout(repoUrl: string, onClose?: () => void): Modal {
  return new Modal({
    title: '(meta)cooler',
    ...(onClose === undefined ? {} : { onClose }),
    body: () =>
      el(
        'div',
        { class: 'about-body' },
        el('p', {
          text:
            'A viewer for .metacool multi-genome Hi-C contact maps, and for the cooler files ' +
            'they extend. It runs entirely in this page: there is no backend, no upload and no ' +
            'preprocessing step.',
        }),
        el('p', {
          text:
            'Local files are read in place, a few kilobytes at a time, by code running in this ' +
            'tab. Remote files are read the same way over HTTP range requests, so opening a map ' +
            'on a bucket costs a few requests rather than a download.',
        }),
        el(
          'p',
          {},
          'Source, issues and the format specification: ',
          el('a', { href: repoUrl, text: repoUrl, class: 'link' }),
        ),
      ),
  })
}
