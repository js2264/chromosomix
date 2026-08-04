/**
 * Give the release its changelog section, and refuse a release with none.
 *
 * Run by npm's `version` lifecycle hook, which fires *after* the version in
 * `package.json` has been bumped and *before* the release commit is made. That
 * window is the only place this work can happen, and it is why the rename below
 * lives here rather than in a step a human is asked to remember.
 *
 * ## Why it renames rather than only checks
 *
 * `preversion` runs the fixture-free suite, which includes `version.test.ts`,
 * which asserts that the newest `## [X.Y.Z]` section *is* the version
 * `package.json` claims. So the two hooks want opposite states of this file and
 * a human editing it beforehand cannot satisfy both:
 *
 * - leave `## [Unreleased]`, and `preversion` passes while this hook rejects a
 *   changelog with no section for the new number;
 * - rename it to `## [0.3.0]` first, and this hook would pass — but `preversion`
 *   now compares a `0.3.0` heading against a `package.json` still reading
 *   `0.2.0` and fails before the bump ever happens.
 *
 * Between those two moments the bump has landed and nothing has been committed,
 * so here the rename is unambiguous: `Unreleased` means "whatever is about to be
 * released", and by now that number is known. Write entries under
 * `## [Unreleased]` and never touch the heading; this names it.
 *
 * A section already named for this version is left exactly as it is — that is
 * the re-run, and the hand-edited release, and neither should be rewritten.
 *
 * ## What it does not do
 *
 * The check is deliberately shallow: that a section for this version exists. A
 * script cannot tell whether an entry is a good description of what changed, and
 * pretending to would only teach people to write whatever gets past it.
 *
 * And note what failing here does leave behind, because it is not nothing: npm
 * has already written the new version into `package.json` and has not committed
 * it. There is no tag and no commit, but the bump is sitting in the working
 * tree, so recovery is `git checkout -- package.json` before trying again.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const changelogPath = new URL('CHANGELOG.md', root)
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

let changelog
try {
  changelog = readFileSync(changelogPath, 'utf8')
} catch {
  console.error('CHANGELOG.md is missing; a release needs one.')
  process.exit(1)
}

// `## [0.2.0] - 2026-08-03`, the Keep a Changelog heading. The date is not
// checked: a release prepared on one day and cut on the next is normal.
const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm')
const unreleased = /^## \[Unreleased\].*$/m

if (heading.test(changelog)) {
  console.log(`CHANGELOG.md already documents ${version}; left as written.`)
} else if (unreleased.test(changelog)) {
  // The local calendar date, not `toISOString()`: cutting a release at half
  // past midnight would otherwise date it yesterday, and a changelog is read by
  // people who were there.
  const now = new Date()
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-')
  changelog = changelog.replace(unreleased, `## [${version}] - ${date}`)
  writeFileSync(changelogPath, changelog)
  console.log(`CHANGELOG.md: [Unreleased] is now [${version}] - ${date}.`)
} else {
  console.error(
    `CHANGELOG.md has no "## [${version}]" section and no "## [Unreleased]" one to name.\n` +
      'Add one describing what changed, then run `npm version` again.\n' +
      'The bump is already in package.json: `git checkout -- package.json` first.',
  )
  process.exit(1)
}

execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: root, stdio: 'inherit' })
console.log(`Staged with the version bump to ${version}.`)
