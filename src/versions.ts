/**
 * Which build this is, and which other builds are still reachable.
 *
 * The site is rebuilt and republished on every push to `main`, so "the viewer"
 * is not one artifact but a stream of them. That is fine until a figure comes
 * out different from the one somebody made last month, or a `.metacool` that
 * opened in July does not open now: at that point the only useful question is
 * *which build*, and the only useful answer is one you can go and run.
 *
 * So every push also publishes a copy of itself under its own commit —
 * `…/v/<commit>/` — and a manifest at the site root lists the copies that are
 * still there (`versions.json`, written by `scripts/archive-versions.mjs`).
 * This module is what the app knows about that arrangement:
 *
 * - **where it is**, which it reads out of its own base path rather than out of
 *   a build flag. `import.meta.env.BASE_URL` is already baked in and already
 *   has to be right for the page to load at all, so deriving the answer from it
 *   cannot disagree with reality — a `define` could, and would do it silently
 *   in exactly one of the two configs;
 * - **what else is published**, fetched on demand and never at startup: the
 *   manifest is a convenience, not something the viewer needs in order to open
 *   a file, and a page that made a network request before it could draw would
 *   be a page that fails to start on a train.
 *
 * Nothing here runs in the desktop build. An installer is versioned by being an
 * installer, `TARGET` says so, and `fetchVersions()` refuses rather than asking
 * `app://viewer/` for a file that is not in the package.
 *
 * The parsing is deliberately paranoid, for the same reason `app/sessions.ts`
 * is: this is untrusted input that outlives the build which wrote it. A field
 * that fails its check drops the entry rather than being repaired into a menu
 * row leading nowhere.
 */

import { TARGET } from './version'

/** The path segment archived builds are published under, below the site root. */
export const ARCHIVE_SEGMENT = 'v'

/**
 * The path segment pull-request previews are published under, beside `v/`.
 *
 * A preview is an archived build of a branch (`.github/workflows/preview.yml`):
 * the same copy, not installable and with no worker, at `pr/<number>/` — and
 * unlike a push it is replaced on every push to the pull request and removed
 * when the pull request closes, which is why it has a directory of its own and
 * a group of its own in the menu rather than a row among the commits.
 */
export const PULL_SEGMENT = 'pr'

/**
 * The path segments the rendered notebooks are published under, beside `v/`
 * and `pr/`: the validation and the timings (`.github/workflows/notebooks.yml`,
 * SPECS §18.10). Pages of their own rather than builds — named here so that a
 * service worker that answered one with this app's shell can be undone
 * (`recoverPinnedNavigation()` in `src/pwa.ts`); `src/sw.js` keeps the same
 * list, since it imports nothing.
 */
export const NOTEBOOK_SEGMENTS = ['validation', 'timings'] as const

/** The manifest's file name, at the site root. */
export const MANIFEST_FILE = 'versions.json'

/**
 * A short hash, as `git rev-parse --short` writes it — seven characters, more
 * once a repository is big enough to need them. Also the directory name, which
 * is why the pattern is strict: it ends up in a URL this app navigates to.
 */
const COMMIT = /^[0-9a-f]{7,40}$/

/** How much of a commit subject is worth putting in a tooltip. */
const SUBJECT_LIMIT = 120

/**
 * A tag name, on the same terms `scripts/versions-manifest.mjs` publishes one.
 *
 * Narrower than git's own rules on purpose: a tag is also a *directory* beside
 * the commits, so a slash would nest it somewhere unintended. Checked again
 * here rather than trusted, because this side reads the file over the network
 * and puts what it finds into a link.
 */
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/** One published build. */
export interface VersionEntry {
  /** Short commit hash, and the directory the build is published under. */
  commit: string
  /** The `package.json` version that commit carried. */
  version: string
  /** The commit's own timestamp, ISO 8601. Empty when it could not be read. */
  date: string
  /** The commit subject, one line. Empty when it could not be read. */
  subject: string
  /**
   * The tag on that commit — a release — or `''`.
   *
   * Worth carrying separately from `version` even though the two nearly always
   * say the same thing, because "nearly always" is the problem: every build
   * between two releases reports the version of the release *before* it, and
   * only the tag says which one is the release.
   */
  tag: string
}

/** One pull-request preview, published under `pr/<number>/`. */
export interface PullEntry {
  /** The pull request's number, and the directory the preview is under. */
  number: number
  /** The head commit the preview was built from, short. */
  commit: string
  /** The pull request's title, as typed, bounded. */
  title: string
  /** The branch it comes from, bounded. */
  branch: string
  /** The head commit's timestamp, ISO 8601, or `''`. */
  date: string
}

/** The manifest, once it has survived being read. */
export interface Versions {
  /** The commit the site root is serving. */
  latest: string
  /** Every published build, newest first. */
  entries: VersionEntry[]
  /** Every open pull request with a preview, newest first. Often empty. */
  pulls: PullEntry[]
}

/**
 * Split a base path into the site it belongs to and the commit it is pinned to.
 *
 * `/chromosomix/v/a1b2c3d/` is one archived build of the site at
 * `/chromosomix/`; `/chromosomix/` is the site itself and is pinned to
 * nothing. Exported for the test, because this is the one piece of arithmetic
 * here that has an off-by-one in it.
 */
export function splitBase(base: string): {
  site: string
  commit: string | null
  pull: number | null
} {
  const archived = /^(.*\/)v\/([0-9a-f]{7,40})\/$/.exec(base)
  if (archived !== null) {
    return { site: archived[1] as string, commit: archived[2] as string, pull: null }
  }
  // A preview: the same kind of copy, pinned to a pull request rather than to
  // a commit — the commit it was built from is in the manifest, not the path.
  const preview = /^(.*\/)pr\/([1-9][0-9]{0,6})\/$/.exec(base)
  if (preview !== null) {
    return { site: preview[1] as string, commit: null, pull: Number(preview[2]) }
  }
  return { site: base, commit: null, pull: null }
}

const HERE = splitBase(import.meta.env.BASE_URL)

/**
 * The root of the deployment, whichever build is running.
 *
 * An archived build has to reach *up* — for the manifest, for the demo data,
 * for the way back to the newest build — and this is the only thing that knows
 * how far up that is.
 */
export const SITE_BASE: string = HERE.site

/** The commit this build is pinned to, or `null` when it is the site itself. */
export const PINNED_COMMIT: string | null = HERE.commit

/** The pull request this build previews, or `null` when it is not a preview. */
export const PINNED_PULL: number | null = HERE.pull

/** `true` for any copy served from a sub-path: an archived push or a preview. */
export const IS_PINNED = PINNED_COMMIT !== null || PINNED_PULL !== null

/**
 * `true` when this build does not know where it is served from.
 *
 * Every other build bakes a root-absolute base: the site's `/chromosomix/`, an
 * archived copy's `/chromosomix/v/<commit>/`, the desktop renderer's `/`. The
 * package build (`vite.package.config.ts`) is the one that cannot — a tarball is
 * unpacked into a lab site, a course page or a registry CDN, and the whole point
 * of it is that one published version serves all three — so its base is `./`.
 *
 * Two things follow, and both are absences rather than behaviours. **There is no
 * site root**: `SITE_BASE` resolves against the document, so asking it for
 * `versions.json` would be asking whichever directory the copy was unpacked into
 * for a manifest that only the deployment has. And **there is no scope to
 * claim**: a service worker registered from a path this build does not own would
 * be claiming one on somebody else's site, or on a CDN, over somebody else's
 * package.
 *
 * Read off `BASE_URL` rather than out of a `define`, for the reason this module's
 * header gives about `SITE_BASE`: the base is already baked in and already has
 * to be right for the page to load at all, so an answer derived from it cannot
 * disagree with reality.
 */
export const IS_PORTABLE = !import.meta.env.BASE_URL.startsWith('/')

/**
 * Is this page running something older than what the site root now serves?
 *
 * Only ever true at the root itself, and it means one thing: a service worker
 * is answering with a shell it cached earlier. That is the app's own design —
 * an update installs and *waits* rather than swapping the code under a
 * half-read file (`src/pwa.ts`) — but it makes "go to the newest build" a lie
 * when the way there is an ordinary navigation, because the worker answers
 * that navigation from the same cache and the page comes back unchanged. The
 * picker has to know, so that it can take the update instead of walking into
 * it.
 *
 * A build with no commit stamp — a tarball, a test — knows nothing and is
 * therefore never stale: an unknown answer must not become an accusation.
 */
export function isStaleShell(running: string, latest: string, pinned: string | null): boolean {
  return pinned === null && running !== '' && running !== latest
}

/**
 * Where a given build lives. `null` is the newest, which is the site root.
 *
 * A release's tag alias has the same shape — `…/v/v0.5.1/` is a redirect to
 * `…/v/<commit>/`, written by `scripts/archive-versions.mjs` — so this builds
 * that too, and the name is `name` rather than `commit` because the directory
 * does not care which it was given.
 */
export function versionPath(site: string, name: string | null): string {
  return name === null ? site : `${site}${ARCHIVE_SEGMENT}/${name}/`
}

/** Where a pull request's preview lives. */
export function pullPath(site: string, number: number): string {
  return `${site}${PULL_SEGMENT}/${number}/`
}

/**
 * Validate a manifest that arrived over the network.
 *
 * Returns `null` rather than throwing, and rather than a half-manifest: every
 * caller's fallback is the same — say nothing and offer nothing — so there is
 * no information in the difference between the ways this can fail.
 */
export function parseVersions(raw: unknown): Versions | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  const latest = record['latest']
  if (typeof latest !== 'string' || !COMMIT.test(latest)) return null

  const list = Array.isArray(record['versions']) ? record['versions'] : []
  const entries: VersionEntry[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const commit = row['commit']
    // One row per commit. A duplicate is not a second build to offer, it is a
    // manifest that was merged wrong, and the first row wins because the list
    // is newest first.
    if (typeof commit !== 'string' || !COMMIT.test(commit) || seen.has(commit)) continue
    seen.add(commit)
    const tag = row['tag']
    entries.push({
      commit,
      version: text(row['version'], 32),
      date: text(row['date'], 32),
      subject: text(row['subject'], SUBJECT_LIMIT),
      tag: typeof tag === 'string' && TAG.test(tag) && !COMMIT.test(tag) ? tag : '',
    })
  }
  // A manifest that lists nothing is the same as no manifest, and saying so
  // here means no caller has to check both.
  if (entries.length === 0) return null

  // Previews, on the same terms: a row that could not name a directory is
  // dropped, and a manifest written before previews existed has none.
  const pulls: PullEntry[] = []
  const numbers = new Set<number>()
  for (const item of Array.isArray(record['pulls']) ? record['pulls'] : []) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as Record<string, unknown>
    const number = row['number']
    const commit = row['commit']
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) continue
    if (number > 9_999_999 || numbers.has(number)) continue
    if (typeof commit !== 'string' || !COMMIT.test(commit)) continue
    numbers.add(number)
    pulls.push({
      number,
      commit,
      title: text(row['title'], SUBJECT_LIMIT),
      branch: text(row['branch'], 100),
      date: text(row['date'], 32),
    })
  }
  pulls.sort((a, b) => b.number - a.number)
  return { latest, entries, pulls }
}

/**
 * How one preview reads in a menu: `PR #12 · a1b2c3d — the title`.
 *
 * The number first, because it is the address (`pr/12/`) and the thing a
 * reviewer has in the tab next door; the title after the dash, bounded the way
 * a commit subject is, because it is the only part that says what the change
 * is.
 */
export function pullLabel(entry: PullEntry): string {
  const head = [`PR #${entry.number}`, entry.commit].join(' · ')
  return entry.title === '' ? head : `${head} — ${entry.title}`
}

/** A string field, trimmed and bounded, or `''` if it was anything else. */
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

/**
 * Read the manifest, or decide there isn't one.
 *
 * Every failure lands on `null`: no manifest on this deployment (a dev server,
 * a `vite preview`, a fresh site whose first archiving deploy has not run), no
 * network, a proxy answering HTML, a file somebody edited by hand. None of
 * those is worth an error on screen — the viewer's job is to open files, and it
 * does that whether or not it can name its siblings.
 *
 * `cache: 'no-cache'` because this file changes on every deploy and is the one
 * URL in the app that is not content-hashed: revalidate it, or a reader is
 * offered the list that was current when they first arrived.
 */
export async function fetchVersions(): Promise<Versions | null> {
  if (TARGET !== 'web') return null
  // …and nothing published beside a copy that was unpacked somewhere, which is
  // not the same refusal: the desktop build has no site, and this one has no way
  // to know whether the directory it is sitting in belongs to one. Asking would
  // be a 404 against a stranger's server every time somebody opens About.
  if (IS_PORTABLE) return null
  try {
    const response = await fetch(`${SITE_BASE}${MANIFEST_FILE}`, { cache: 'no-cache' })
    if (!response.ok) return null
    return parseVersions((await response.json()) as unknown)
  } catch {
    return null
  }
}

/**
 * How one build reads in a menu:
 * `0.5.1 · a1b2c3d · 2026-08-05 — release v0.5.1, latest`.
 *
 * The first three facts in the same order as the about dialog's build line, so
 * the row a reader picks and the stamp they see afterwards are recognisably the
 * same thing. Parts that are unknown are absent rather than empty, which is the
 * rule `buildLine()` follows for the same reason.
 *
 * The markers after the dash are what a reader is actually scanning the list
 * for. **release** is not redundant with the version beside it: every build
 * between two releases reports the earlier release's version, so a list without
 * this marker shows a dozen rows saying `0.5.1` of which exactly one is
 * `v0.5.1`. The tag is named rather than implied because it does not have to
 * match — `v0.5.1` and `0.5.1` are the convention here, not a rule.
 */
export function versionLabel(entry: VersionEntry, latest: boolean): string {
  const parts = [entry.version, entry.commit, entry.date.slice(0, 10)].filter((p) => p !== '')
  const marks = [entry.tag === '' ? '' : `release ${entry.tag}`, latest ? 'latest' : ''].filter(
    (mark) => mark !== '',
  )
  return marks.length === 0 ? parts.join(' · ') : `${parts.join(' · ')} — ${marks.join(', ')}`
}
