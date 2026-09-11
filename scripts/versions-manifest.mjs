/**
 * Which past builds the site keeps, and which it lets go.
 *
 * Shared by `scripts/archive-versions.mjs`, which runs in the deploy job and
 * owns the files, and by `test/unit/versions-manifest.test.ts`, which is the
 * only way to check a retention rule without publishing a wrong one first —
 * and a wrong one deletes builds, which is the mistake that cannot be undone by
 * pushing again.
 *
 * The problem this solves is a budget. A GitHub Pages site may be **1 GB**, of
 * which this one already spends ~250 MB on the demo datasets it publishes; an
 * archived build is ~5 MB with the data and the source maps left out
 * (`vite.pinned.config.ts`). So the archive can be generous but not unbounded,
 * and "unbounded" is what a rule of the form "keep everything" becomes after a
 * year of pushes to `main`.
 *
 * Three rules, because there are three reasons anyone opens an old build:
 *
 * 1. **The last {@link KEEP_RECENT} pushes**, which is the debugging window —
 *    "it worked on Tuesday" is a question about a handful of commits, and by
 *    the time it is about fifty the answer is a bisect and not a dropdown.
 * 2. **Every tagged commit**, forever. A release is what somebody cites in a
 *    methods section, and one that answers 404 two months later is worse than
 *    never having offered it. This is the exact rule: the tag names the build.
 * 3. **The oldest build of each distinct `package.json` version**, forever,
 *    which is rule 2 for the case where the tag is not visible yet.
 *
 * That third rule wants explaining, because the obvious version of it is wrong.
 * `npm version minor` bumps `package.json` and tags *the same commit* — so the
 * **oldest** build carrying a version is the release, and the newest one
 * carrying it is whatever was pushed just before the next bump. A rule that
 * kept the newest would keep a build that calls itself `0.6.0`, is labelled
 * `0.6.0` in the menu, and is not `v0.6.0`: the one outcome worse than not
 * keeping it at all. It also churns — the kept build would change under every
 * push — whereas the oldest is decided once, when the version first appears,
 * and never moves.
 *
 * Keeping both 2 and 3 is deliberate. Tags are read from the remote
 * (`archive-versions.mjs`) and `git push --follow-tags` sends the commit and
 * the tag together, so the tag is normally there — but a release pushed in two
 * steps would deploy before its tag existed, and rule 3 is what catches that
 * build anyway. Neither rule needs the other to be correct; each covers a hole
 * in the other's assumptions.
 *
 * Everything here is a pure function over plain objects. The caller reads,
 * writes and deletes; this only ever decides.
 */

/** How many of the most recent builds stay addressable regardless of version. */
export const KEEP_RECENT = 20

/** A short commit hash, which is also the directory a build is published in. */
const COMMIT = /^[0-9a-f]{7,40}$/

/**
 * A tag name this is willing to put in a URL.
 *
 * Deliberately narrower than git's own rules. A tag becomes a **directory name
 * beside the commits** — `v/v0.5.1/` redirects to `v/<commit>/` — so a slash
 * would nest it somewhere unintended and a leading dot would be a name no
 * server serves. It is also written into an HTML page unescaped, which this
 * character class is what makes safe.
 *
 * `release/1.0` and `déjà` are therefore not published as aliases. The build is
 * still archived and still in the menu; it just has no name of its own, which
 * is a fair trade for not generating a path out of arbitrary text.
 */
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/** The path segment pull-request previews are published under, beside `v/`. */
export const PULL_SEGMENT = 'pr'

/** A pull request number, as a directory name: no sign, no leading zero, no size. */
const PULL_NUMBER = /^[1-9][0-9]{0,6}$/

/** An empty manifest, which is what a first deploy starts from. */
export const EMPTY = { latest: '', versions: [], pulls: [] }

/**
 * One pull-request preview, or `null` when the row could not name a directory.
 *
 * The number is the directory, so it is held to what a directory name can be;
 * the title and the branch are arbitrary text somebody typed and are carried
 * as text, bounded, because they end up in a menu and a tooltip and nowhere
 * that interprets them (`src/ui/VersionPicker.ts`).
 */
function pullRow(entry) {
  if (typeof entry !== 'object' || entry === null) return null
  const number = Number(entry.number)
  if (!Number.isInteger(number) || !PULL_NUMBER.test(String(number))) return null
  const commit = entry.commit
  if (typeof commit !== 'string' || !COMMIT.test(commit)) return null
  return {
    number,
    commit,
    title: string(entry.title).slice(0, 200),
    branch: string(entry.branch).slice(0, 200),
    date: string(entry.date),
  }
}

/** Newest pull request first — the number is the order they were opened in. */
function byNumberDesc(a, b) {
  return b.number - a.number
}

/**
 * Is this a tag that may be published as a directory beside the commits?
 *
 * The second test is the one that is easy to miss: a tag spelt like a short
 * hash would claim the directory a *build* is published in, and the alias would
 * overwrite it. Vanishingly unlikely and trivially cheap to rule out.
 */
export function isPublishableTag(tag) {
  return typeof tag === 'string' && TAG.test(tag) && !COMMIT.test(tag)
}

/**
 * Read a manifest that may not exist, may be empty, and may have been edited.
 *
 * Same posture as `src/versions.ts` reading it over the network: anything that
 * fails its check is dropped rather than repaired. The consequence of being
 * lenient here is a manifest row pointing at a directory that was never
 * published, which is a 404 offered from a menu.
 */
export function parseManifest(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return { ...EMPTY }
  }
  if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.versions)) return { ...EMPTY }
  const pulls = []
  const numbers = new Set()
  for (const entry of Array.isArray(raw.pulls) ? raw.pulls : []) {
    const row = pullRow(entry)
    if (row === null || numbers.has(row.number)) continue
    numbers.add(row.number)
    pulls.push(row)
  }
  pulls.sort(byNumberDesc)
  const versions = []
  const seen = new Set()
  for (const entry of raw.versions) {
    if (typeof entry !== 'object' || entry === null) continue
    const commit = entry.commit
    if (typeof commit !== 'string' || !COMMIT.test(commit) || seen.has(commit)) continue
    seen.add(commit)
    versions.push({
      commit,
      version: string(entry.version),
      date: string(entry.date),
      subject: string(entry.subject),
      tag: isPublishableTag(entry.tag) ? entry.tag : '',
    })
  }
  return { latest: typeof raw.latest === 'string' ? raw.latest : '', versions, pulls }
}

function string(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * The manifest after this build: the new one added, the rules applied.
 *
 * Sorted by the commit's own timestamp rather than by arrival, because arrival
 * order is a property of the *runner* and not of the history — a re-run of an
 * older commit through `workflow_dispatch` would otherwise put a build from
 * March at the top of the menu and call everything below it older.
 *
 * `latest` is the build that was just made, whatever its date, because that is
 * the literal truth about what the site root is now serving. The two can
 * disagree, and when they do the menu shows the newest commit first and marks a
 * row further down as the one at the root — which is confusing exactly once,
 * for as long as it takes somebody to push again.
 */
export function nextManifest(previous, build, keepRecent = KEEP_RECENT) {
  if (typeof build.commit !== 'string' || !COMMIT.test(build.commit)) {
    throw new Error(`not a commit hash: ${JSON.stringify(build.commit)}`)
  }
  const merged = [
    {
      commit: build.commit,
      version: string(build.version),
      date: string(build.date),
      subject: string(build.subject),
      tag: isPublishableTag(build.tag) ? build.tag : '',
    },
    ...previous.versions.filter((entry) => entry.commit !== build.commit),
  ]
  // Descending, and stable, so an entry with no date at all sinks rather than
  // scrambling the ones around it. ISO 8601 sorts correctly as text, which is
  // the reason the timestamp is stored in that form and not as a date.
  merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  // Rule 1: the debugging window. Plus this build, whatever its date — a
  // `workflow_dispatch` rebuild of something ancient is still what the root is
  // serving, and publishing a site that does not list its own build would be
  // the one inconsistency a reader is guaranteed to hit.
  const keep = new Set([build.commit])
  for (const entry of merged.slice(0, keepRecent)) keep.add(entry.commit)

  // Rule 2: every release, by its tag.
  for (const entry of merged) if (entry.tag !== '') keep.add(entry.commit)

  // Rule 3: the *oldest* build of each version — see the note at the top of
  // this file, because the newest is the plausible answer and the wrong one.
  const versions = new Set()
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const entry = merged[i]
    if (entry.version === '' || versions.has(entry.version)) continue
    versions.add(entry.version)
    keep.add(entry.commit)
  }

  return {
    latest: build.commit,
    versions: merged.filter((entry) => keep.has(entry.commit)),
    // Previews are somebody else's rows: a push to `main` neither adds one nor
    // takes one away. They come and go with their pull requests, below.
    pulls: previous.pulls ?? [],
  }
}

/**
 * The manifest with one pull request's preview in it — added, or replaced.
 *
 * Replaced rather than listed twice, because a pull request is pushed to many
 * times and every push is a new preview under the same number: the directory
 * is overwritten and this is the row that says which commit is in it now.
 * Throws on a row that could not name a directory, for the reason
 * {@link nextManifest} does: publishing a menu entry that 404s is the failure.
 */
export function withPull(previous, entry) {
  const row = pullRow(entry)
  if (row === null) throw new Error(`not a pull request preview: ${JSON.stringify(entry)}`)
  const pulls = [row, ...(previous.pulls ?? []).filter((held) => held.number !== row.number)]
  pulls.sort(byNumberDesc)
  return { ...previous, pulls }
}

/** The manifest without one pull request's preview — what closing it does. */
export function withoutPull(previous, number) {
  return { ...previous, pulls: (previous.pulls ?? []).filter((held) => held.number !== number) }
}

/** The directory a preview is published in, relative to the site root. */
export function pullDirectory(number) {
  return `${PULL_SEGMENT}/${number}`
}

/**
 * Which commits are in the old manifest and not the new one.
 *
 * The build directories to remove, in other words. Derived by comparison rather
 * than returned from {@link nextManifest} so that the deletion is driven by
 * what is actually being published: a caller that wrote a manifest and then
 * deleted a different set of directories is the failure this shape rules out.
 *
 * It is also what makes a failed manifest *read* harmless rather than
 * catastrophic. An unreadable `versions.json` parses to an empty manifest, so
 * `previous` is empty, so this returns nothing and the run deletes nothing —
 * where a rule of the form "delete every directory the new manifest does not
 * mention" would have emptied the archive.
 */
export function droppedCommits(previous, next) {
  const kept = new Set(next.versions.map((entry) => entry.commit))
  return previous.versions.map((entry) => entry.commit).filter((commit) => !kept.has(commit))
}

/** The tag aliases the new manifest no longer covers, on the same terms. */
export function droppedTags(previous, next) {
  const kept = new Set(next.versions.map((entry) => entry.tag).filter((tag) => tag !== ''))
  return previous.versions
    .map((entry) => entry.tag)
    .filter((tag) => tag !== '' && !kept.has(tag))
}

/** Every tag the new manifest publishes, with the commit it points at. */
export function tagAliases(manifest) {
  return manifest.versions
    .filter((entry) => entry.tag !== '')
    .map((entry) => ({ tag: entry.tag, commit: entry.commit }))
}
