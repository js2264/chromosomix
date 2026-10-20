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
import { groupRank, isMac, keyCap, optionKey, shiftKey, stateChip, type Command } from './commands'
import { buildLine } from '../version'
import { LICENSED, noticesUrl } from '../licences'
import { devFeature } from '../state/devFeatures'
import type { TourProgress } from '../state/tour'
import { tutorialButtons } from './tutorialOffer'

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
    .replace(/\{opt\}/g, optionKey())
    .replace(/\{shift\}/g, shiftKey())
    .replace(/\{ceil\}/g, mac ? '⌘' : 'Alt')
    // The key the browser reports as `metaKey`: ⌘ on a Mac, the Windows key
    // elsewhere — what slides a map up and down (`render/heatmap.ts`).
    .replace(/\{meta\}/g, mac ? '⌘' : 'Win')
}

/** `render/heatmap.ts` → `handleKeyDown` and `attach`. Keep in step with them. */
const CANVAS_KEYS: Array<[string, string]> = [
  ['drag', 'Pan'],
  ['{opt} + drag', 'Select a square and open it as a region — on the diagonal while it is locked'],
  ['{shift} + {opt} + drag', 'The same, pinned to the diagonal from the nearest bin on it'],
  // The map's own gesture in one dimension (§8.9), and the reason the row above
  // says *pinned*: Shift is the on-diagonal modifier throughout, and a table
  // that listed it only beside Option said Shift alone did nothing.
  ['{shift} + drag', 'Zoom to the stretch it spans, on the diagonal, and copy its locus'],
  ['double click', 'Fit the block back to the canvas'],
  ['wheel', 'Zoom about the pointer'],
  // Along the diagonal, rows and columns together, while the view is held on
  // it — `slideSideways` — and the columns alone otherwise (§7.2).
  ['two fingers sideways', 'Slide sideways — down the diagonal while it is locked (Space)'],
  ['{meta} + wheel', 'Slide the map up and down, and sideways with it'],
  ['click', 'Open what the cell refers to'],
  ['← ↑ → ↓', 'Pan by a tenth of the view (half a view with Shift)'],
  ['Page Up / Page Down', 'Zoom in and out about the centre'],
  // No `+ / −` row and no `0`: on a map the two step the resolution and the
  // `0` refits from anywhere, and all three are commands — *Coarser
  // resolution*, *Finer resolution* and *Fit the view*, in the View block above.
  ['Home', 'Fit the block to the canvas'],
  // The lanes are part of this picture, and their gestures are the browser's
  // rather than the canvas's — which is exactly the kind of thing that is
  // undiscoverable unless it is written down beside the map it is on.
  // `MatrixPanel`'s lane handlers: the border a resize grabs is the lane's far
  // one, away from the map, and a drag across the lane is its ceiling.
  ['drag a lane’s far edge', 'Make that track thicker or thinner'],
  ['drag across a lane', 'Raise or lower that track’s ceiling'],
  [
    'drag a lane’s grip',
    'Reorder it; drop it on a rectangle round this map or another to move it there, on a + or an empty cell to give it a cell of its own, or on a tracks cell to draw it there',
  ],
  [
    'drag a track’s row from the panel',
    'Reorder it, or drop it on a rectangle round any map, a + or an empty cell to draw it there',
  ],
  ['click a lane', 'Open that track’s settings'],
  ['click a feature in a lane', 'Open its card — names, attributes, exons'],
  ['drop a file on an edge of the map', 'Load it as a track on that edge'],
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
  ['drag the bar under the tracks', 'Make every track taller or shorter, each in proportion'],
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
  // No `0` row: it is *Fit the view*, a command, in the View block above.
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
    el('kbd', { class: 'kbd' }, ...keyCap(command.keys ?? '')),
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

/**
 * The guided tutorial, as *About* offers it (§30): where the reader got to,
 * and the one call that plays it.
 */
export interface AboutTutorial {
  progress: TourProgress | null
  play(from: 'start' | 'resume'): void
}

export function openAbout(
  repoUrl: string,
  platform?: AboutPlatform | null,
  onClose?: () => void,
  tutorial?: AboutTutorial | null,
): Modal {
  return new Modal({
    // Titled for what it is, like every other dialog, rather than for the
    // brand, which `.modal-title` would shout in capitals.
    title: 'About this viewer',
    // Wider and taller than a plain dialog, for the licences' three columns:
    // at 34rem each project's line broke in two, and the build stamp under
    // them was a scroll away.
    variant: 'modal-about',
    ...(onClose === undefined ? {} : { onClose }),
    body: (close) =>
      el(
        'div',
        { class: 'about-body' },
        // The one place a reader holding a bigWig and no contact map is told
        // this application is for them too (§24.2). It was inside the landing
        // page's drop target, where it was a paragraph that cost the page its
        // fold (`ui/LoadBox.ts`); said here it is a clause in the sentence that
        // was already naming what opens.
        // The first thing the dialog says is what the viewer opens, so it is
        // the first sentence a dev feature (§29) must stay out of: switched
        // off, `.metacool` is not something this viewer reads, and a sentence
        // selling it would be the one place the reader was told otherwise.
        el('p', {
          text:
            (devFeature('metacool')
              ? 'A viewer for .metacool multi-genome Hi-C contact maps, for the cooler files ' +
                'they extend, and for the tracks, genomes and 3D models beside them — with or ' +
                'without a map. '
              : 'A viewer for Hi-C contact maps — cooler, .hic, .pairs and HiC-Pro — and for the ' +
                'tracks, genomes and 3D models beside them, with or without a map. ') +
            'It runs entirely in this page: there is no backend, no upload and no ' +
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
        // Straight after what the viewer is, because it is the answer to the
        // question a reader who has just read that asks next — *so how do I
        // start* — and it is the one way in to the tutorial a newcomer will
        // find without being told where to look (§30).
        ...(tutorial === undefined || tutorial === null ? [] : [tutorialOffer(tutorial, close)]),
        el(
          'p',
          {},
          'Source, issues and the format specification: ',
          el('a', { href: repoUrl, text: repoUrl, class: 'link' }),
        ),
        licences(repoUrl),
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

/**
 * Whose work this is, and on what terms: chromosomix's own licence, the
 * projects it is built with (`licences.ts`), and where each licence is
 * reproduced in full.
 *
 * Above the version rather than under it, because it is read and the stamp is
 * copied. Each project is named by what it does here, since "zrender" says
 * nothing to a reader and "draws the analysis charts" does.
 */
function licences(repoUrl: string): HTMLElement {
  const outside = { target: '_blank', rel: 'noopener noreferrer' }
  return el(
    'section',
    { class: 'about-licences', attrs: { 'aria-labelledby': 'about-licences-title' } },
    el('h3', { class: 'about-heading', text: 'Licences', attrs: { id: 'about-licences-title' } }),
    el(
      'p',
      {},
      'chromosomix is free and open-source software, under the ',
      el('a', { text: 'MIT licence', class: 'about-link', attrs: { href: `${repoUrl}/blob/main/LICENSE`, ...outside } }),
      '. It is built with, and in places ported from, the work of these projects, each under its own licence:',
    ),
    el(
      'ul',
      { class: 'about-licence-list' },
      ...LICENSED.map((entry) =>
        el(
          'li',
          { class: 'about-licence-row' },
          el(
            'span',
            { class: 'about-licence-name' },
            el('a', { text: entry.name, class: 'about-link', attrs: { href: entry.url, ...outside } }),
            ...(entry.with === undefined ? [] : [' ', el('span', { class: 'about-licence-with', text: entry.with })]),
          ),
          el('span', { class: 'about-licence-what', text: entry.what }),
          el('span', { class: 'about-licence-id', text: entry.licence }),
        ),
      ),
    ),
    el(
      'p',
      {},
      'Every build carries each of those licences in full, in ',
      el('a', { text: 'THIRD-PARTY-NOTICES.txt', class: 'link about-notices', attrs: { href: noticesUrl(), ...outside } }),
      '.',
    ),
    el('p', {
      class: 'about-fine',
      text:
        'The logos of the data stores, and the GitHub, Google Drive and Dropbox marks, are their ' +
        'owners’ trademarks, shown only to name what they stand for. Their use implies no ' +
        'endorsement of this viewer.',
    }),
  )
}

/**
 * The guided tutorial (§30): one sentence on what it is, and the button that
 * plays it — or carries it on from the step the reader left it at, with the way
 * back to its start beside it (`ui/tutorialOffer.ts`, which the landing page
 * draws too).
 */
function tutorialOffer(tutorial: AboutTutorial, close: () => void): HTMLElement {
  return el(
    'div',
    { class: 'about-tutorial' },
    el('p', {
      class: 'about-tutorial-text',
      text:
        'New here? The guided tutorial walks through a first session on a real map from 4DN — ' +
        'the store, a chromosome, its compartments and domains — one step at a time.',
    }),
    el(
      'div',
      { class: 'about-tutorial-actions' },
      ...tutorialButtons(
        tutorial.progress,
        (from) => {
          close()
          tutorial.play(from)
        },
        { class: 'about-tutorial-play' },
      ),
    ),
  )
}
