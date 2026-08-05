/**
 * Choosing which build of the viewer to run, and being told when you are not
 * running the newest one.
 *
 * Two controls, one fact between them. The site publishes every push and keeps
 * the recent ones addressable under `…/v/<commit>/` (`src/versions.ts`), which
 * is only worth doing if there is a way in and a way back:
 *
 * - **the picker**, in the about dialog, beside the build stamp it is the
 *   continuation of. That dialog is already where "which version am I running"
 *   is answered, and putting the answer's *sequel* anywhere else would be a
 *   second place to look;
 * - **the notice**, a bar in the corner of a pinned build, because the failure
 *   mode this whole feature can create is somebody working for an afternoon in
 *   a build from July without noticing. A bar that says so, and one button back
 *   to the newest.
 *
 * Both are web-only, and not by a guard bolted on here: an archived build is a
 * path on a website, `PINNED_COMMIT` is read out of that path, and the desktop
 * renderer is served from `app://viewer/` where there is no such path and no
 * manifest to fetch. `fetchVersions()` refuses on that target in any case.
 *
 * **Switching is a navigation, not a swap.** The two builds are different
 * documents; there is no in-place upgrade to be had, and pretending otherwise
 * would mean shipping a loader whose job is to run code from another commit.
 * What travels is what is written down: the query string and the hash, which
 * between them are the whole view state (§5.5), and the tab strip, which lives
 * in `sessionStorage` and is therefore the same window's memory on either side.
 * A file opened from local disk does not travel, for the reason it does not
 * survive a reload either — no browser re-reads a dropped file without a fresh
 * gesture — so the hint says so rather than letting it be discovered.
 */

import { COMMIT, TARGET } from '../version'
import {
  PINNED_COMMIT,
  SITE_BASE,
  fetchVersions,
  versionLabel,
  versionPath,
  type Versions,
} from '../versions'
import { button, el } from './dom'

/** Where a dismissed notice is remembered: this tab, not this browser. */
const DISMISSED = 'metacooler-viewer:pinned-notice-dismissed'

/**
 * Go to another build, carrying the view.
 *
 * `assign` rather than `replace`: the reader chose to step sideways, and the
 * back button is how they undo a choice.
 */
function goTo(commit: string | null): void {
  const path = versionPath(SITE_BASE, commit)
  window.location.assign(`${path}${window.location.search}${window.location.hash}`)
}

/** One button, back to the newest build, carrying the view. */
function latestButton(): HTMLButtonElement {
  return button('newest build', () => goTo(null), {
    class: 'btn btn-small',
    title: 'Reload this view from the newest published build',
  })
}

/**
 * The row in the about dialog: a select, and a line saying what a switch costs.
 *
 * Returned already mounted and *empty of choices*, because the manifest is a
 * network read and the dialog is not going to wait for one. It fills itself in
 * when the answer arrives, and when there is no answer it says the one true
 * thing it can — this deployment does not publish a list — rather than an
 * error, because on a dev server and in `vite preview` that is simply the case.
 */
export function versionPicker(): HTMLElement | null {
  if (TARGET !== 'web') return null

  const row = el('div', { class: 'version-picker' })
  const note = el('p', { class: 'version-note', text: 'Looking for other published builds…' })
  row.appendChild(note)

  void fetchVersions().then((versions) => {
    if (versions !== null) {
      row.replaceChildren(...picker(versions))
      return
    }
    // No list. On a dev server that is the truth and the end of it; on a pinned
    // build it is a reader stranded in an old commit with nothing to click, so
    // the way out is offered from what this build already knows about itself.
    if (PINNED_COMMIT === null) {
      note.textContent = 'This deployment does not publish a list of past builds.'
      return
    }
    note.textContent = `This build is pinned to commit ${PINNED_COMMIT}, and the list of published builds could not be read.`
    row.appendChild(latestButton())
  })

  return row
}

/** The select and its hint, once the manifest is in. */
function picker(versions: Versions): HTMLElement[] {
  // What is running, as the manifest would name it. The pinned build knows from
  // its own path; the site root knows from its build stamp — and those can
  // disagree for one visit, when a deploy has landed and the page on screen is
  // the previous one still being served from cache. Selecting nothing rather
  // than guessing keeps the control honest: it never shows a row that is not
  // what is running.
  const current = PINNED_COMMIT ?? COMMIT
  const known = versions.entries.some((entry) => entry.commit === current)

  const select = el('select', {
    class: 'select version-select',
    attrs: { 'aria-label': 'Which build of the viewer to run' },
  })

  if (!known) {
    // A build the manifest has never heard of: a local `preview`, or one old
    // enough to have been pruned. Named, disabled and selected, so the control
    // does not open claiming to be something it is not.
    const unknown = el('option', {
      value: '',
      text: COMMIT === '' ? 'this build' : `this build · ${COMMIT}`,
    })
    unknown.disabled = true
    select.appendChild(unknown)
  }

  for (const entry of versions.entries) {
    const option = el('option', {
      value: entry.commit,
      text: versionLabel(entry, entry.commit === versions.latest),
    })
    // The subject is what tells two same-day builds apart, and it is far too
    // long for a menu row — so it is the tooltip rather than the label.
    if (entry.subject !== '') option.title = entry.subject
    select.appendChild(option)
  }
  select.value = known ? current : ''

  select.addEventListener('change', () => {
    const commit = select.value
    if (commit === '' || commit === current) return
    // The newest build is served from the site root, which is the copy with the
    // service worker and the install prompt behind it. Sending someone to
    // `v/<latest>/` instead would hand them a second, worker-less copy of the
    // same code and quietly cost them offline.
    goTo(commit === versions.latest ? null : commit)
  })

  const rows = [
    el('div', { class: 'version-row' }, el('span', { text: 'Run build' }), select),
    el('p', {
      class: 'version-note',
      text:
        'Switching reloads the viewer from that commit. The view in the address bar and the ' +
        'open tabs come with you; a file you opened from your own disk does not, and has to ' +
        'be dropped again — the same as after any reload.',
    }),
  ]

  // A release has a second, permanent address — its tag — and that is the one
  // worth writing down. A commit URL is equally permanent but says nothing to a
  // reader; `…/v/v0.5.1/` is what belongs in a methods section, and offering it
  // only when the build in front of you *is* a release is what keeps it from
  // being a line of chrome nobody reads.
  const running = versions.entries.find((entry) => entry.commit === current)
  if (running !== undefined && running.tag !== '') {
    const href = new URL(versionPath(SITE_BASE, running.tag), window.location.href).href
    rows.push(
      el(
        'p',
        { class: 'version-note' },
        `This build is release ${running.tag}, so it also answers, permanently, at `,
        el('a', { class: 'link version-permalink', href, text: href }),
        '.',
      ),
    )
  }

  return rows
}

/**
 * The corner bar an archived build shows about itself.
 *
 * Modelled on the update offer in `src/pwa.ts` and placed beside it, because it
 * is the same kind of statement: a fact about which code is running, which is
 * worth saying out loud and is never urgent enough for a dialog over a contact
 * map.
 *
 * Dismissible, and dismissed for the tab rather than forever: someone who
 * pinned a build on purpose does not need to be told about it every time they
 * open a file, and someone who arrived on a stale link an hour ago does need to
 * be told again tomorrow. The about dialog says it unconditionally in any case,
 * which is what makes the bar safe to close.
 *
 * The commit's date is not in the bundle — only the manifest knows it — so the
 * bar names what it can immediately and adds the date if the fetch answers. A
 * bar that appeared half a second late would be worse than one that grows a few
 * characters.
 */
export function mountPinnedNotice(): void {
  if (TARGET !== 'web' || PINNED_COMMIT === null) return
  if (remembered(DISMISSED)) return

  const what = el('span', { text: `You are running the build from commit ${PINNED_COMMIT}.` })
  const close = el('button', {
    class: 'btn-quiet update-close',
    text: '×',
    type: 'button',
    title: 'Hide this until this tab is opened again',
  })
  const bar = el(
    'div',
    { class: 'update-bar pinned-bar', attrs: { role: 'status' } },
    what,
    latestButton(),
    close,
  )
  close.addEventListener('click', () => {
    remember(DISMISSED)
    bar.remove()
  })

  document.body.appendChild(bar)

  void fetchVersions().then((versions) => {
    const entry = versions?.entries.find((candidate) => candidate.commit === PINNED_COMMIT)
    const date = entry === undefined ? '' : entry.date.slice(0, 10)
    if (date === '') return
    what.textContent = `You are running the build from ${date} (commit ${PINNED_COMMIT}).`
  })
}

/** `sessionStorage`, or nothing — a browser that refuses storage still runs. */
function remembered(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) !== null
  } catch {
    return false
  }
}

function remember(key: string): void {
  try {
    window.sessionStorage.setItem(key, '1')
  } catch {
    /* the bar comes back on the next load, which is the harmless direction */
  }
}
