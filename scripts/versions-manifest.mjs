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
 * Two rules, because there are two reasons anyone opens an old build:
 *
 * 1. **The last {@link KEEP_RECENT} pushes**, which is the debugging window —
 *    "it worked on Tuesday" is a question about a handful of commits, and by
 *    the time it is about fifty the answer is a bisect and not a dropdown.
 * 2. **The newest build of every `package.json` version ever published**, which
 *    is the archive proper. A released version is a thing people cite in a
 *    methods section, and one that answers 404 two months later is worse than
 *    never having offered it. There is one of these per release, so the set
 *    grows at the rate releases happen and not at the rate pushes do.
 *
 * The second rule is why a release is worth cutting even though the site is
 * built from every push: the version number is what makes a build *keepable*.
 *
 * Everything here is a pure function over plain objects. The caller reads,
 * writes and deletes; this only ever decides.
 */

/** How many of the most recent builds stay addressable regardless of version. */
export const KEEP_RECENT = 20

/** A short commit hash, which is also the directory a build is published in. */
const COMMIT = /^[0-9a-f]{7,40}$/

/** An empty manifest, which is what a first deploy starts from. */
export const EMPTY = { latest: '', versions: [] }

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
    })
  }
  return { latest: typeof raw.latest === 'string' ? raw.latest : '', versions }
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
    { commit: build.commit, version: string(build.version), date: string(build.date), subject: string(build.subject) },
    ...previous.versions.filter((entry) => entry.commit !== build.commit),
  ]
  // Descending, and stable, so an entry with no date at all sinks rather than
  // scrambling the ones around it. ISO 8601 sorts correctly as text, which is
  // the reason the timestamp is stored in that form and not as a date.
  merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const keep = new Set([build.commit])
  for (const entry of merged.slice(0, keepRecent)) keep.add(entry.commit)
  // The newest surviving build of each distinct version, taken in the sorted
  // order, so "newest" means newest commit and not first seen.
  const versions = new Set()
  for (const entry of merged) {
    if (entry.version === '' || versions.has(entry.version)) continue
    versions.add(entry.version)
    keep.add(entry.commit)
  }

  return { latest: build.commit, versions: merged.filter((entry) => keep.has(entry.commit)) }
}

/**
 * Which commits are in the old manifest and not the new one.
 *
 * The directories to remove, in other words. Derived by comparison rather than
 * returned from {@link nextManifest} so that the deletion is driven by what is
 * actually being published: a caller that wrote a manifest and then deleted a
 * different set of directories is the failure this shape rules out.
 */
export function droppedCommits(previous, next) {
  const kept = new Set(next.versions.map((entry) => entry.commit))
  return previous.versions.map((entry) => entry.commit).filter((commit) => !kept.has(commit))
}
