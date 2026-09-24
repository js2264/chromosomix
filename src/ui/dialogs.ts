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
import { versionPicker } from './VersionPicker'
import { el } from './dom'
import { groupRank, isMac, keyLabel, stateChip, type Command } from './commands'
import { buildLine } from '../version'

/**
 * The modifier a gesture actually wants, on the machine reading the dialog.
 *
 * Written `{opt}` / `{shift}` / `{ceil}` / `{meta}` in the tables and resolved here.
 * The tables used to print both spellings — `⌥ / Alt + drag` — which asks a
 * reader to work out which half is theirs, in a dialog whose whole job is to
 * tell them what to press; and the pair could not say that the ceiling gesture
 * is genuinely a *different* key on the two platforms (⌘ on a Mac, Alt
 * elsewhere, because a trackpad pinch arrives as Ctrl-wheel — see
 * `ui/BrowserView.ts`), so it was printed `⌘ / Alt` beside the map's `⌥ / Alt`
 * and the difference read as a typo.
 */
function gestureKeys(pattern: string): string {
  const mac = isMac()
  return pattern
    .replace(/\{opt\}/g, mac ? '⌥' : 'Alt')
    .replace(/\{shift\}/g, mac ? '⇧' : 'Shift')
    .replace(/\{ceil\}/g, mac ? '⌘' : 'Alt')
    // The key the browser reports as `metaKey`: ⌘ on a Mac, the Windows key
    // elsewhere — what slides a map up and down (`render/heatmap.ts`).
    .replace(/\{meta\}/g, mac ? '⌘' : 'Win')
}

/** `render/heatmap.ts` → `handleKeyDown` and `attach`. Keep in step with them. */
const CANVAS_KEYS: Array<[string, string]> = [
  ['drag', 'Pan'],
  ['{opt} + drag', 'Select a square and open it as a region'],
  ['{shift} + {opt} + drag', 'The same, pinned to the diagonal from the nearest bin on it'],
  ['double click', 'Fit the block back to the canvas'],
  ['wheel', 'Zoom about the pointer'],
  ['two fingers sideways', 'Slide the map left and right'],
  ['{meta} + wheel', 'Slide the map up and down, and sideways with it'],
  ['click', 'Open what the cell refers to'],
  ['← ↑ → ↓', 'Pan by a tenth of the view (half a view with Shift)'],
  ['+ / −', 'Zoom about the centre'],
  ['0 or Home', 'Fit the block to the canvas'],
  // The lanes are part of this picture, and their gestures are the browser's
  // rather than the canvas's — which is exactly the kind of thing that is
  // undiscoverable unless it is written down beside the map it is on.
  ['drag a lane’s inner edge', 'Make that track thicker or thinner'],
  ['drag a lane’s grip', 'Reorder it, or drop it on either rectangle in the map to change edge'],
  ['drag a track’s row from the panel', 'The same, for the reader looking at the list'],
  ['click a lane', 'Open that track’s settings'],
  ['click a feature in a lane', 'Open its card — names, attributes, exons'],
  ['drop a file below or right of the map', 'Load it as a track on that edge'],
]

/**
 * `ui/BrowserView.ts` → `watchPointer` and `watchKeys`. Keep in step with them.
 *
 * The 1D browser's gestures are not the map's, and listing only the map's left
 * every one of these undiscoverable: the drag that selects a span needs no
 * modifier *on the ruler* and does need one over the tracks, which is exactly
 * the kind of thing a reader finds by being told.
 */
const BROWSER_KEYS: Array<[string, string]> = [
  ['drag', 'Pan along the genome'],
  ['drag on the chromosome bar', 'Select a span, with both ends written out to the base'],
  ['{opt} + drag', 'The same selection, over the tracks'],
  ['drag a track’s lower edge', 'Make that track taller or shorter'],
  ['drag a track’s grip', 'Move it up or down the stack'],
  ['double click', 'The whole genome'],
  ['wheel', 'Zoom about the pointer'],
  ['{ceil} + wheel over a track', 'Raise or lower that track’s ceiling'],
  ['click a chromosome’s name', 'Go to that chromosome'],
  ['click a feature', 'Open its card — names, attributes, exons, and a zoom'],
  ['click a track’s range', 'Type a limit'],
  ['drop a file on the tracks', 'Load it — a .cool opens the map on this genome'],
  ['← →', 'Pan by a fifth of the window'],
  ['+ / −', 'Zoom about the centre'],
  ['0', 'The whole genome'],
]

function keyRow(keys: string, description: string): HTMLElement {
  return el(
    'div',
    { class: 'shortcut-row' },
    el('kbd', { class: 'kbd', text: keys }),
    el('span', { class: 'shortcut-text', text: description }),
  )
}

/**
 * A command's row: its key, its title, and its state where it has one.
 *
 * Greyed when the command cannot act, the way the palette greys it — the two
 * lists are two printings of one registry, and one of them quietly claiming
 * that `W` shows the whole genome while the other says the session has no
 * genome to show it for is the kind of disagreement a reader resolves by
 * pressing the key and distrusting the app.
 */
function commandRow(command: Command): HTMLElement {
  const off = command.enabled === false
  return el(
    'div',
    { class: off ? 'shortcut-row disabled' : 'shortcut-row' },
    el('kbd', { class: 'kbd', text: keyLabel(command.keys ?? '') }),
    el('span', { class: 'shortcut-text', text: command.title }),
    ...stateChip(command),
  )
}

export function openShortcuts(commands: Command[], onClose?: () => void): Modal {
  return new Modal({
    title: 'Keyboard shortcuts',
    // Wider than the other wide dialogs, because this one's content is three
    // columns of short rows: at 46rem the key block was two columns, the View
    // group's twenty-one rows set the dialog's height on its own, and the two
    // gesture tables — the part a reader new to a genome browser needs most —
    // began exactly at the bottom edge with none of their rows showing.
    variant: 'modal-shortcuts',
    ...(onClose === undefined ? {} : { onClose }),
    body: () => {
      const bound = commands.filter((command) => command.keys !== undefined)
      const groups = new Map<string, Command[]>()
      for (const command of bound) {
        const list = groups.get(command.group) ?? []
        list.push(command)
        groups.set(command.group, list)
      }
      // The palette's order (`commands.ts` → `GROUP_ORDER`), so the two lists of
      // the one registry read the same way round.
      const ordered = [...groups].sort(([a], [b]) => groupRank(a) - groupRank(b))
      // Two blocks, not one flow. The keys are short rows and *flow* into as
      // many columns as the dialog is wide (`.shortcut-grid` is a multi-column
      // block, so a two-row group is followed by the next group rather than by
      // a hole the height of the tallest group beside it); the two gesture
      // tables are the long ones and are the pair a reader compares — "what
      // does a drag do here, and what does it do there" — so they stay a grid
      // of two side by side rather than falling wherever the group count
      // happens to put them.
      return el(
        'div',
        { class: 'shortcut-body' },
        el(
          'div',
          { class: 'shortcut-grid' },
          ...ordered.map(([group, list]) =>
            el(
              'section',
              { class: 'shortcut-group' },
              el('h3', { text: group }),
              ...list.map((command) => commandRow(command)),
            ),
          ),
        ),
        el(
          'div',
          { class: 'shortcut-grid shortcut-gestures' },
          el(
            'section',
            { class: 'shortcut-group' },
            el('h3', { text: 'On a contact map' }),
            ...CANVAS_KEYS.map(([keys, text]) => keyRow(gestureKeys(keys), text)),
          ),
          el(
            'section',
            { class: 'shortcut-group' },
            el('h3', { text: 'On the genome browser' }),
            ...BROWSER_KEYS.map(([keys, text]) => keyRow(gestureKeys(keys), text)),
          ),
        ),
      )
    },
  })
}

/**
 * What the desktop build knows about itself, when it is the one running.
 *
 * A plain interface and an optional argument, never an import from `electron/`:
 * this module is in the bundle the **web** build ships, and a Node import here
 * would end up in it. The caller passes what it has, which on the website is
 * nothing.
 */
export interface AboutPlatform {
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  signed: boolean
}

export function openAbout(
  repoUrl: string,
  platform?: AboutPlatform | null,
  onClose?: () => void,
): Modal {
  return new Modal({
    // Titled for what it is, like every other dialog. It was the brand, which
    // `.modal-title` uppercases — and the mark is written *(meta)cooler*
    // everywhere else, so shouted in caps it read as a different word.
    title: 'About this viewer',
    ...(onClose === undefined ? {} : { onClose }),
    body: () =>
      el(
        'div',
        { class: 'about-body' },
        // The one place a reader holding a bigWig and no contact map is told
        // this application is for them too (§24.2). It was inside the landing
        // page's drop target, where it was a paragraph that cost the page its
        // fold (`ui/LoadBox.ts`); said here it is a clause in the sentence that
        // was already naming what opens.
        el('p', {
          text:
            'A viewer for .metacool multi-genome Hi-C contact maps, for the cooler files they ' +
            'extend, and for the tracks, genomes and 3D models beside them — with or without a ' +
            'map. It runs entirely in this page: there is no backend, no upload and no ' +
            'preprocessing step.',
        }),
        // Same substitution as `FilePicker.ts`, and for the same reason: the
        // claim is reworded once to be true of both targets rather than
        // branched, because "in this tab" is false in a window that is not one.
        el('p', {
          text:
            'Local files are read in place, a few kilobytes at a time, by code running on your ' +
            'own computer. Remote files are read the same way over HTTP range requests, so ' +
            'opening a map on a bucket costs a few requests rather than a download.',
        }),
        el(
          'p',
          {},
          'Source, issues and the format specification: ',
          el('a', { href: repoUrl, text: repoUrl, class: 'link' }),
        ),
        // Last, small, and selectable: it is the first thing to ask for in a
        // bug report about a page that has no server to interrogate, and the
        // last thing anyone reads for pleasure.
        el('p', { class: 'about-build', text: `version ${buildLine()}` }),
        // Directly under the stamp, because it is the same question continued:
        // the line above says which build this is, and this says which other
        // ones are still published and lets the reader go and run one. `null`
        // on the desktop target, where an installer is versioned by being an
        // installer and there is no site to hold the other builds.
        versionPicker(),
        // The runtime, read from `process.versions` at preload time rather than
        // written down anywhere: Electron's Chromium and Node move within a
        // major, and a number pinned in the repository would be wrong within a
        // week and believed anyway, because it is under the word "version".
        ...(platform === undefined || platform === null
          ? []
          : [
              el('p', {
                class: 'about-build',
                text:
                  `Electron ${platform.electron} · Chromium ${platform.chrome} · ` +
                  `Node ${platform.node} · ${platform.platform} ${platform.arch}`,
              }),
            ]),
        // The answer to the warning the user clicked through to get here. They
        // were told the developer could not be verified; this is where they
        // find out that this was expected and what it does and does not mean.
        ...(platform !== undefined && platform !== null && !platform.signed
          ? [
              el('p', {
                class: 'about-build',
                text:
                  'This build is not code-signed. A signature says who published a build, ' +
                  'not whether it works — which is why macOS and Windows each warned you once.',
              }),
            ]
          : []),
      ),
  })
}
