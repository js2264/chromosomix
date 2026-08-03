/**
 * Refuse a release the changelog does not mention.
 *
 * Run by npm's `version` lifecycle hook, which fires *after* the version in
 * `package.json` has been bumped and *before* the release commit is made — so
 * failing here leaves nothing half-done for the next person to unpick, and
 * staging the changelog here puts it in the same commit as the bump rather than
 * in a follow-up nobody remembers to make.
 *
 * The check is deliberately shallow: that a section for this version exists. A
 * script cannot tell whether an entry is a good description of what changed,
 * and pretending to would only teach people to write whatever gets past it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = new URL('..', import.meta.url)
const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

let changelog
try {
  changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8')
} catch {
  console.error('CHANGELOG.md is missing; a release needs one.')
  process.exit(1)
}

// `## [0.2.0] - 2026-08-03`, the Keep a Changelog heading. The date is not
// checked: a release prepared on one day and cut on the next is normal.
const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm')
if (!heading.test(changelog)) {
  console.error(
    `CHANGELOG.md has no "## [${version}]" section.\n` +
      'Add one describing what changed, then run `npm version` again.',
  )
  process.exit(1)
}

execFileSync('git', ['add', 'CHANGELOG.md'], { cwd: root, stdio: 'inherit' })
console.log(`CHANGELOG.md documents ${version}; staged with the version bump.`)
