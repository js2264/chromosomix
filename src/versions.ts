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
}

/** The manifest, once it has survived being read. */
export interface Versions {
  /** The commit the site root is serving. */
  latest: string
  /** Every published build, newest first. */
  entries: VersionEntry[]
}

/**
 * Split a base path into the site it belongs to and the commit it is pinned to.
 *
 * `/metacooler.js/v/a1b2c3d/` is one archived build of the site at
 * `/metacooler.js/`; `/metacooler.js/` is the site itself and is pinned to
 * nothing. Exported for the test, because this is the one piece of arithmetic
 * here that has an off-by-one in it.
 */
export function splitBase(base: string): { site: string; commit: string | null } {
  const match = /^(.*\/)v\/([0-9a-f]{7,40})\/$/.exec(base)
  if (match === null) return { site: base, commit: null }
  return { site: match[1] as string, commit: match[2] as string }
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

/** Where a given build lives. `null` is the newest, which is the site root. */
export function versionPath(site: string, commit: string | null): string {
  return commit === null ? site : `${site}${ARCHIVE_SEGMENT}/${commit}/`
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
    entries.push({
      commit,
      version: text(row['version'], 32),
      date: text(row['date'], 32),
      subject: text(row['subject'], SUBJECT_LIMIT),
    })
  }
  // A manifest that lists nothing is the same as no manifest, and saying so
  // here means no caller has to check both.
  if (entries.length === 0) return null
  return { latest, entries }
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
  try {
    const response = await fetch(`${SITE_BASE}${MANIFEST_FILE}`, { cache: 'no-cache' })
    if (!response.ok) return null
    return parseVersions((await response.json()) as unknown)
  } catch {
    return null
  }
}

/**
 * How one build reads in a menu: `0.5.1 · a1b2c3d · 2026-08-05`.
 *
 * The same three facts in the same order as the about dialog's build line, so
 * the row a reader picks and the stamp they see afterwards are recognisably the
 * same thing. Parts that are unknown are absent rather than empty, which is the
 * rule `buildLine()` follows for the same reason.
 */
export function versionLabel(entry: VersionEntry, latest: boolean): string {
  const parts = [entry.version, entry.commit, entry.date.slice(0, 10)].filter((p) => p !== '')
  return latest ? `${parts.join(' · ')} — latest` : parts.join(' · ')
}
