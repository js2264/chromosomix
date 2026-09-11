/**
 * Put a pull request's preview into the archive of published builds, or take
 * it out.
 *
 * Run by `.github/workflows/preview.yml`, the way `archive-versions.mjs` is
 * run by the deploy: the rules are in `versions-manifest.mjs`, where a test
 * holds them; the file moves are here.
 *
 *     node scripts/archive-preview.mjs <archive dir> <pinned build dir> <number>   # add or replace
 *     node scripts/archive-preview.mjs <archive dir> --remove <number>              # the PR closed
 *
 * The archive directory is a checkout of the `pages-archive` branch, and a
 * preview lives beside the archived pushes:
 *
 *     versions.json          the manifest, now with a `pulls` list
 *     v/<commit>/…           one archived push per directory (archive-versions.mjs)
 *     pr/<number>/…          one preview per open pull request — this script
 *
 * The title and the branch come from the environment (`PR_TITLE`, `PR_BRANCH`)
 * rather than from argv, for the reason `archive-versions.mjs` reads the
 * commit subject from git rather than from a workflow string: a title is
 * arbitrary text, and an environment variable is the one channel that carries
 * it whole. The commit and its date are read from the checkout, which the
 * workflow made at the pull request's head.
 *
 * Idempotent per number: re-running for the same pull request replaces its
 * directory and its one row. Removing a number that is not there is not an
 * error, because a pull request may close before it was ever previewed.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseManifest, pullDirectory, withPull, withoutPull } from './versions-manifest.mjs'

function fail(message) {
  process.stderr.write(`archive-preview: ${message}\n`)
  process.exit(1)
}

/** Ask git one question, with no shell and no interpolation. */
function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const args = process.argv.slice(2)
const archiveDir = args[0]
const removing = args[1] === '--remove'
const buildDir = removing ? null : args[1]
const numberText = removing ? args[2] : args[2]
const number = Number(numberText)

if (archiveDir === undefined || numberText === undefined || !Number.isInteger(number) || number <= 0) {
  fail(
    'usage: node scripts/archive-preview.mjs <archive dir> <pinned build dir> <number>\n' +
      '       node scripts/archive-preview.mjs <archive dir> --remove <number>',
  )
}
if (!removing && !existsSync(buildDir)) {
  fail(`no build at ${buildDir} — run \`npm run build:pinned\` with PINNED_BASE=…/pr/${number}/ first`)
}

const manifestPath = join(archiveDir, 'versions.json')
const previous = existsSync(manifestPath)
  ? parseManifest(readFileSync(manifestPath, 'utf8'))
  : parseManifest('')
const here = join(archiveDir, pullDirectory(number))

if (removing) {
  rmSync(here, { recursive: true, force: true })
  const next = withoutPull(previous, number)
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  process.stdout.write(`removed the preview of #${number} — ${next.pulls.length} left\n`)
} else {
  const row = {
    number,
    commit: git(['rev-parse', '--short', 'HEAD']),
    title: process.env.PR_TITLE ?? '',
    branch: process.env.PR_BRANCH ?? '',
    date: git(['log', '-1', '--format=%cI']),
  }
  if (row.commit === '') fail('could not read the commit — is this a git checkout?')

  // The directory first, the manifest second, for the reason archive-versions.mjs
  // gives: a directory nothing points at is invisible, a row pointing at
  // nothing is a 404 offered from a menu.
  rmSync(here, { recursive: true, force: true })
  mkdirSync(join(archiveDir, 'pr'), { recursive: true })
  cpSync(buildDir, here, { recursive: true })

  const next = withPull(previous, row)
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)
  process.stdout.write(
    `archived the preview of #${number} (${row.commit}${row.branch === '' ? '' : `, ${row.branch}`}) — ` +
      `${next.pulls.length} preview${next.pulls.length === 1 ? '' : 's'} published\n`,
  )
}
