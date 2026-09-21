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
import { takeNewestBuild } from '../pwa'
import {
  PINNED_COMMIT,
  PINNED_PULL,
  SITE_BASE,
  fetchVersions,
  isStaleShell,
  pullLabel,
  pullPath,
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

/**
 * Go to the newest build — which is not the same thing as going to the site
 * root, and that difference is a bug this got wrong first.
 *
 * The root is *where* the newest build is published, but what a visitor is
 * served there is whatever their service worker has cached, and a navigation is
 * exactly the request that worker answers from cache. Ask the worker for the
 * update first (`takeNewestBuild`); only navigate if there was nothing to take.
 *
 * `stuck` says we already know this page is not the newest, which is the case
 * where the worker has to be got out of the way rather than asked politely.
 */
/** A preview is a navigation like any other build: the view comes along. */
function goToPull(number: number): void {
  const path = pullPath(SITE_BASE, number)
  window.location.assign(`${path}${window.location.search}${window.location.hash}`)
}

async function goToNewest(stuck: boolean): Promise<void> {
  if (await takeNewestBuild(stuck)) return
  goTo(null)
}

/**
 * How a build reads inside a sentence: `0.6.0 (c797c1e)`, or the bare commit
 * when the manifest has never heard of it.
 *
 * Shorter than the menu row on purpose — a date is what tells two rows apart in
 * a list and is noise in prose, where the two things being compared are the
 * only two things there.
 */
function describeBuild(
  entry: { version: string; commit: string } | undefined,
  fallback: string,
): string {
  if (entry === undefined) return fallback === '' ? 'an unknown build' : fallback
  return entry.version === '' ? entry.commit : `${entry.version} (${entry.commit})`
}

/** One button, back to the newest build, carrying the view. */
function latestButton(): HTMLButtonElement {
  return button('newest build', () => void goToNewest(false), {
    class: 'btn btn-small',
    title: 'Reload this view from the newest published build',
  })
}

/**
 * The row in the about dialog: a select, and a line saying what a switch costs.
 *
 * Returned already mounted and *empty of choices*, because the manifest is a
 * network read and the dialog is not going to wait for one. It fills itself in
 * when the answer arrives — and when there is no answer and nothing is pinned,
 * it **takes itself away**: a site that publishes no manifest has no picker, so
 * a line about a list of past builds is a sentence about a control that is not
 * there, which is the one thing §8.5 says not to draw. Every reader opens this
 * dialog, and none of them can act on it.
 *
 * A pinned build is the other case and keeps its sentence, because there the
 * missing list is a reader stranded in an old commit: the note says which
 * commit they are on and the button beside it is the way back.
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
    // No list. On a dev server that is the truth and the end of it — and the
    // end of the row, since there is no picker for a sentence to be about; on a
    // pinned build it is a reader stranded in an old commit with nothing to
    // click, so the way out is offered from what this build knows about itself.
    if (PINNED_COMMIT === null && PINNED_PULL === null) {
      row.remove()
      return
    }
    note.textContent =
      PINNED_PULL !== null
        ? `This build is the preview of pull request #${PINNED_PULL}, and the list of published builds could not be read.`
        : `This build is pinned to commit ${PINNED_COMMIT}, and the list of published builds could not be read.`
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
  const running = versions.entries.find((entry) => entry.commit === current)
  // A preview knows the pull request it is, from its path; the manifest says
  // which commit that preview holds now, which may not be this one if a push
  // has landed since the page was loaded — then the row is offered unselected.
  const preview =
    PINNED_PULL === null
      ? undefined
      : versions.pulls.find((entry) => entry.number === PINNED_PULL && entry.commit === COMMIT)
  const known = running !== undefined || preview !== undefined

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
      text:
        PINNED_PULL !== null
          ? `this preview of PR #${PINNED_PULL}${COMMIT === '' ? '' : ` · ${COMMIT}`}`
          : COMMIT === ''
            ? 'this build'
            : `this build · ${COMMIT}`,
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

  // Previews in a group of their own, after the builds: they are somebody's
  // work in progress, not versions of the site, and a reviewer looking for one
  // should not have to tell it apart from a release by its label.
  if (versions.pulls.length > 0) {
    const group = el('optgroup', { attrs: { label: 'Pull request previews' } })
    for (const entry of versions.pulls) {
      const option = el('option', { value: `pr:${entry.number}`, text: pullLabel(entry) })
      option.title = [entry.branch, entry.date.slice(0, 10)].filter((part) => part !== '').join(' · ')
      group.appendChild(option)
    }
    select.appendChild(group)
  }
  select.value = preview !== undefined ? `pr:${preview.number}` : known ? current : ''

  // Running the root build, but not the one the root now publishes: a worker is
  // serving a cache from an earlier visit. It changes what "go to the newest"
  // has to mean, and it is worth saying out loud — until this was written the
  // menu simply showed an older build as the selected one and left the reader
  // to work out why picking the newest did nothing.
  // A preview is pinned for this purpose: it is not the root, so the root's
  // cache is not what is serving it.
  const stale = isStaleShell(COMMIT, versions.latest, PINNED_PULL === null ? PINNED_COMMIT : COMMIT)

  select.addEventListener('change', () => {
    const commit = select.value
    if (commit.startsWith('pr:')) {
      const number = Number(commit.slice('pr:'.length))
      if (number !== PINNED_PULL) goToPull(number)
      return
    }
    if (commit === '' || commit === current) return
    // The newest build is served from the site root, which is the copy with the
    // service worker and the install prompt behind it. Sending someone to
    // `v/<latest>/` instead would hand them a second, worker-less copy of the
    // same code and quietly cost them offline. But the root is also the one
    // destination a stale worker can refuse to deliver, which is what
    // `goToNewest` is for.
    if (commit === versions.latest) {
      void goToNewest(stale)
      return
    }
    goTo(commit)
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

  if (stale) {
    const newest = versions.entries.find((entry) => entry.commit === versions.latest)
    rows.push(
      el('p', {
        class: 'version-note version-stale',
        text:
          `This page is running ${describeBuild(running, COMMIT)} from the offline cache, while the site ` +
          `now publishes ${describeBuild(newest, versions.latest)}. Choosing it above takes the update — ` +
          'an ordinary reload will not, because the cache is what answers one.',
      }),
    )
  }

  // A release has a second, permanent address — its tag — and that is the one
  // worth writing down. A commit URL is equally permanent but says nothing to a
  // reader; `…/v/v0.5.1/` is what belongs in a methods section, and offering it
  // only when the build in front of you *is* a release is what keeps it from
  // being a line of chrome nobody reads.
  if (preview !== undefined) {
    rows.push(
      el('p', {
        class: 'version-note',
        text:
          `This is the preview of pull request #${preview.number}` +
          `${preview.branch === '' ? '' : ` (${preview.branch})`}, built from ${preview.commit}. ` +
          'It is replaced on every push to the pull request and removed when it closes, so it is ' +
          'not an address to cite.',
      }),
    )
  }

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
  if (TARGET !== 'web' || (PINNED_COMMIT === null && PINNED_PULL === null)) return
  if (remembered(DISMISSED)) return

  const what = el('span', {
    text:
      PINNED_PULL !== null
        ? `You are running the preview of pull request #${PINNED_PULL}.`
        : `You are running the build from commit ${PINNED_COMMIT}.`,
  })
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
    if (PINNED_PULL !== null) {
      const pull = versions?.pulls.find((candidate) => candidate.number === PINNED_PULL)
      if (pull === undefined) return
      what.textContent =
        `You are running the preview of pull request #${PINNED_PULL}` +
        `${pull.branch === '' ? '' : ` (${pull.branch})`}, built from ${pull.commit}.`
      return
    }
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
