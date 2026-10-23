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
import { el, trimNumber } from './dom'
import { groupRank, isMac, keyCap, optionKey, shiftKey, stateChip, type Command } from './commands'
import { TARGET, buildLine } from '../version'
import { LICENSED, noticesUrl } from '../licences'
import {
  NOTEBOOKS,
  fetchStamp,
  notebookUrl,
  notebooksSite,
  stampUrl,
  type Notebook,
  type NotebookStamp,
  type StampReader,
} from '../notebooks'
import { devFeature } from '../state/devFeatures'
import type { TourProgress } from '../state/tour'
import { tutorialButtons } from './tutorialOffer'
import {
  browserDeclines,
  setTelemetry,
  startTelemetry,
  telemetryHost,
  telemetryOffered,
  telemetryWanted,
} from '../telemetry'

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

/**
 * Where *About*'s Notebooks tab finds the notebooks, and how it reads their
 * stamps: `read` is `null` where nothing may be fetched — the single file, whose
 * policy allows no request (§19) — and the tab then links the pages alone.
 */
export interface AboutNotebooks {
  site: string
  read: StampReader | null
}

/** *About*'s tabs, by the names their panels and buttons are found under. */
type AboutTab = 'overview' | 'notebooks' | 'licences'

export function openAbout(
  repoUrl: string,
  platform?: AboutPlatform | null,
  onClose?: () => void,
  tutorial?: AboutTutorial | null,
  notebooks?: AboutNotebooks | null,
): Modal {
  // Undefined is this build's own answer; `null` is a caller saying there is
  // none, which is how a test opens the dialog without one.
  const published = notebooks === undefined ? defaultNotebooks() : notebooks
  return new Modal({
    // Titled for what it is, like every other dialog, rather than for the
    // brand, which `.modal-title` would shout in capitals.
    title: 'About this viewer',
    // Wider and taller than a plain dialog, for the licences' three columns:
    // at 34rem each project's line broke in two.
    variant: 'modal-about',
    ...(onClose === undefined ? {} : { onClose }),
    body: (close) =>
      el(
        'div',
        { class: 'about-body' },
        tabbed([
          {
            id: 'overview',
            label: 'Overview',
            panel: () => overview(repoUrl, tutorial, close),
            // The build, on the tab about the viewer and nowhere else: the other
            // two are each about one thing — the notebooks, the licences — and
            // a stamp and a picker under them were a third thing on each.
            foot: () => buildFoot(platform),
          },
          // Absent where no site can be named — a test, or a copy with no
          // homepage — rather than a tab of links leading nowhere (§8.5).
          ...(published === null
            ? []
            : [{ id: 'notebooks' as const, label: 'Notebooks', panel: () => notebooksPanel(published) }]),
          { id: 'licences', label: 'Licences', panel: () => licences(repoUrl) },
        ]),
      ),
  })
}

/**
 * Which build this is, and the others still published: the Overview tab's
 * footer, outside the part that scrolls, so it stays on screen however far the
 * overview is scrolled — it is the first thing to ask for in a bug report about
 * a page that has no server to interrogate.
 */
function buildFoot(platform: AboutPlatform | null | undefined): HTMLElement {
  return el(
    'footer',
    { class: 'about-foot' },
    // Small, and selectable: copied, and not read for pleasure.
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
  )
}

/** This build's notebooks: the site's, read with `fetch` except in the single file. */
function defaultNotebooks(): AboutNotebooks | null {
  const site = notebooksSite()
  return site === null ? null : { site, read: TARGET === 'standalone' ? null : (url) => fetch(url) }
}

/**
 * A row of tabs over the panels they choose between, the first one shown.
 *
 * The WAI-ARIA tabs pattern, by hand like the rest of the dialogs: one stop in
 * the caret's walk for the whole row — the chosen tab — with ← and → moving
 * along it and Home and End to its ends, choosing as they go, since every
 * panel is already built and showing one costs nothing. A panel is built the
 * first time it is chosen, so a tab that reads the network does so when the
 * reader asks for it and not when *About* opens.
 */
function tabbed(
  tabs: Array<{ id: AboutTab; label: string; panel: () => HTMLElement; foot?: () => HTMLElement }>,
): HTMLElement {
  const row = el('div', { class: 'about-tabs', attrs: { role: 'tablist', 'aria-label': 'About this viewer' } })
  const scroller = el('div', { class: 'about-panels' })
  const buttons: HTMLButtonElement[] = []
  const panels: Array<HTMLElement | null> = tabs.map(() => null)
  // A tab's own footer, under the part that scrolls and shown with its tab
  // alone. Built with the tab's panel, and kept, like it.
  const feet: Array<HTMLElement | null> = tabs.map(() => null)
  const footing = el('div', { class: 'about-feet' })
  const choose = (index: number, focus: boolean): void => {
    tabs.forEach((tab, at) => {
      const on = at === index
      const button = buttons[at] as HTMLButtonElement
      button.setAttribute('aria-selected', String(on))
      button.tabIndex = on ? 0 : -1
      button.classList.toggle('is-on', on)
      let panel = panels[at] ?? null
      if (on && panel === null) {
        panel = el(
          'div',
          {
            class: `about-panel about-panel-${tab.id}`,
            id: `about-panel-${tab.id}`,
            attrs: { role: 'tabpanel', 'aria-labelledby': `about-tab-${tab.id}` },
          },
          tab.panel(),
        )
        panels[at] = panel
        scroller.appendChild(panel)
        const foot = tab.foot?.() ?? null
        if (foot !== null) {
          feet[at] = foot
          footing.appendChild(foot)
        }
      }
      panel?.toggleAttribute('hidden', !on)
      feet[at]?.toggleAttribute('hidden', !on)
    })
    // Each tab opens at its top, not at wherever the last one was scrolled to.
    scroller.scrollTop = 0
    if (focus) buttons[index]?.focus()
  }
  tabs.forEach((tab, at) => {
    const button = el('button', {
      class: 'about-tab',
      text: tab.label,
      type: 'button',
      id: `about-tab-${tab.id}`,
      attrs: { role: 'tab', 'aria-controls': `about-panel-${tab.id}`, 'data-tab': tab.id },
    })
    button.addEventListener('click', () => choose(at, false))
    button.addEventListener('keydown', (event) => {
      const last = tabs.length - 1
      const to =
        event.key === 'ArrowRight'
          ? (at + 1) % tabs.length
          : event.key === 'ArrowLeft'
            ? (at + last) % tabs.length
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? last
                : null
      if (to === null) return
      event.preventDefault()
      choose(to, true)
    })
    buttons.push(button)
    row.appendChild(button)
  })
  choose(0, false)
  return el('div', { class: 'about-tabbed' }, row, scroller, footing)
}

/** What the viewer is, how it reads, the tutorial and the source. */
function overview(repoUrl: string, tutorial: AboutTutorial | null | undefined, close: () => void): HTMLElement {
  return el(
    'div',
    {},
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
    // What the site's telemetry holds and where it goes, with the switch (§31):
    // on the tab About opens on, as the other thing a reader asks of a page
    // before trusting it with their data. Absent where nothing is sent.
    ...(telemetryOffered() ? [telemetrySection()] : []),
  )
}

/** *the validation, the timings and the parity*: notebooks named in a sentence. */
function phrase(notebooks: readonly Notebook[]): string {
  const names = notebooks.map((notebook) => `the ${notebook.title.toLowerCase()}`)
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** "Four", for a sentence that counts the notebooks rather than assuming them. */
const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine']

/**
 * The notebooks GitHub Actions renders with every release (§18.10): each one's
 * page, what it holds chromosomix to, and — read from the `rendered.json`
 * published beside it — the one line of what it found, and when, from which
 * build and on what it was rendered.
 *
 * The stamps are read when this tab is first chosen, all at once. Until one
 * answers its row says it is being read; a stamp that cannot be read takes its
 * line away and leaves the link, since a reader offline learns nothing from
 * being told so here, and the page itself says why it is not there.
 */
export function notebooksPanel(notebooks: AboutNotebooks): HTMLElement {
  const outside = { target: '_blank', rel: 'noopener noreferrer' }
  const count = COUNT_WORDS[NOTEBOOKS.length] ?? String(NOTEBOOKS.length)
  const byHand = NOTEBOOKS.filter((notebook) => notebook.byHand === true)
  const byWorkflow = NOTEBOOKS.filter((notebook) => notebook.byHand !== true)
  const laptop =
    byHand.length === 0 ? '' : `; ${phrase(byHand)} ${byHand.length === 1 ? 'is' : 'are'} rendered by hand, on a laptop`
  return el(
    'section',
    { class: 'about-notebooks', attrs: { 'aria-label': 'Notebooks' } },
    el('p', {
      text:
        `${count} notebooks hold chromosomix to the packages it reproduces, to its own command line ` +
        `and to a machine like yours. GitHub Actions renders ${phrase(byWorkflow)} on a fresh runner ` +
        `with every release${laptop}. Each is published beside the app, with its tables.`,
    }),
    el(
      'ul',
      { class: 'about-notebook-list' },
      ...NOTEBOOKS.map((notebook) => {
        const url = notebookUrl(notebooks.site, notebook)
        const found = el('p', { class: 'about-notebook-found hidden' })
        // No line at all where nothing may be fetched, rather than one saying
        // it is reading something it never will.
        const { read } = notebooks
        const stamp =
          read === null ? null : el('p', { class: 'about-notebook-stamp', text: 'Reading when it was rendered…' })
        if (stamp !== null && read !== null) {
          void fetchStamp(stampUrl(notebooks.site, notebook), read).then((answer) => {
            if (answer === null) {
              stamp.remove()
              found.remove()
              return
            }
            stamp.replaceChildren(...stampLine(answer))
            if (answer.summary !== '') {
              found.textContent = answer.summary
              found.classList.remove('hidden')
            }
          })
        }
        return el(
          'li',
          { class: 'about-notebook', attrs: { 'data-notebook': notebook.path } },
          el(
            'div',
            { class: 'about-notebook-head' },
            el('a', {
              text: notebook.title,
              class: 'about-link about-notebook-title',
              attrs: { href: url, ...outside },
            }),
            el('span', { class: 'about-notebook-where', text: url.replace(/^https?:\/\//, '') }),
          ),
          el('p', { class: 'about-notebook-what', text: notebook.what }),
          found,
          stamp,
        )
      }),
    ),
  )
}

/**
 * A stamp as one quiet line: *Rendered 21 October 2026 from chromosomix 0.16.0
 * at 8621d90, in 45 min on 2 cores and 7.7 GB · run 8* — the date in the
 * reader's own words and to the day, and the run linked, since it is where the
 * log of a render that went wrong is; or *· by hand*, where no run rendered it.
 */
function stampLine(stamp: NotebookStamp): Array<string | Node> {
  const when = new Date(stamp.finished).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  const build = stamp.commit === '' ? stamp.version : `${stamp.version} at ${stamp.commit}`
  const took = stamp.seconds === null ? '' : ` in ${renderTime(stamp.seconds)}`
  const machine =
    stamp.machine === null
      ? ''
      : ` on ${stamp.machine.cores} core${stamp.machine.cores === 1 ? '' : 's'}` +
        (stamp.machine.memoryGb === null ? '' : ` and ${trimNumber(stamp.machine.memoryGb, 1)} GB`)
  const how = took === '' && machine === '' ? '' : `,${took}${machine}`
  const line: Array<string | Node> = [`Rendered ${when} from chromosomix ${build}${how}`]
  // A render with no run is one done by hand, which for the laptop is the point (§18.10).
  if (stamp.run === null) line.push(' · by hand')
  if (stamp.run !== null) {
    line.push(
      ' · ',
      el('a', {
        text: stamp.run.number === '' ? 'its run' : `run ${stamp.run.number}`,
        class: 'about-link',
        attrs: { href: stamp.run.url, target: '_blank', rel: 'noopener noreferrer' },
      }),
    )
  }
  return line
}

/** How long a render took, to the minute past one: `45 min`, `2 h 19 min`. */
function renderTime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

/**
 * The telemetry (§31): what is sent, where it goes, and the switch that stops
 * it for this browser.
 *
 * The sentence names the endpoint's host rather than a product, so it stays
 * true of whatever the site is built to send to. A browser that already asks
 * not to be tracked is told it is being taken at its word, and offered no
 * switch, since there is nothing left for one to turn off.
 */
function telemetrySection(): HTMLElement {
  const host = telemetryHost()
  const what = el('p', {
    text:
      'This site sends anonymous telemetry about how it is used — which kinds of file are opened, ' +
      `which analyses run and how long they take, which errors are met — to ${host}. Every value ` +
      'is a word from a fixed list: never a file name, an address, a place on the genome or ' +
      'anything you typed, with no cookie and nothing that tells one visitor from another.',
  })
  let control: HTMLElement
  if (browserDeclines()) {
    control = el('p', {
      class: 'hint',
      text: 'Your browser asks sites not to track it, so this one sends nothing.',
    })
  } else {
    const toggle = el('button', {
      class: 'btn btn-toggle',
      type: 'button',
      text: 'telemetry',
      title: 'Send anonymous telemetry about how this site is used. Off sends nothing from this browser.',
      attrs: { 'aria-pressed': String(telemetryWanted()) },
    })
    toggle.addEventListener('click', () => {
      const on = toggle.getAttribute('aria-pressed') !== 'true'
      setTelemetry(on)
      toggle.setAttribute('aria-pressed', String(on))
      // Turned on from off: this visit is sent from here on.
      if (on) startTelemetry()
    })
    control = el(
      'div',
      { class: 'about-telemetry-switch' },
      toggle,
      el('span', { class: 'hint', text: 'Off sends nothing from this browser.' }),
    )
  }
  return el(
    'section',
    { class: 'about-telemetry', attrs: { 'aria-labelledby': 'about-telemetry-title' } },
    el('h3', { class: 'about-heading', text: 'Telemetry', attrs: { id: 'about-telemetry-title' } }),
    what,
    control,
  )
}

/**
 * Whose work this is, and on what terms: chromosomix's own licence, the
 * projects it is built with (`licences.ts`), and where each licence is
 * reproduced in full.
 *
 * A tab of its own, the dialog's last: a list a reader goes looking for, and
 * one that pushed the build stamp out of sight while it shared a page with
 * what the viewer is. Each project is named by what it does here, since
 * "zrender" says nothing to a reader and "draws the analysis charts" does.
 */
function licences(repoUrl: string): HTMLElement {
  const outside = { target: '_blank', rel: 'noopener noreferrer' }
  return el(
    // No heading of its own: the tab above it is its name, and the panel is
    // labelled by it.
    'section',
    { class: 'about-licences' },
    el(
      'p',
      {},
      'chromosomix is free software, under the ',
      el('a', {
        text: 'GNU General Public License, version 3 or later',
        class: 'about-link',
        attrs: { href: `${repoUrl}/blob/main/LICENSE`, ...outside },
      }),
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
