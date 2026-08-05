/**
 * Put this build into the archive of past builds, and take the old ones out.
 *
 * Run by `.github/workflows/deploy.yml` between building the site and
 * publishing it. Everything it decides comes from `versions-manifest.mjs`,
 * which is tested; everything it *does* is here, because moving directories
 * around is not a thing a unit test should be doing.
 *
 *     node scripts/archive-versions.mjs <archive dir> <pinned build dir>
 *
 * The archive directory is a checkout of the `pages-archive` branch and looks
 * exactly like the subtree it becomes:
 *
 *     versions.json          the manifest the app fetches
 *     v/<commit>/…           one archived build per directory
 *
 * The commit, its date, its subject and the package version are read here
 * rather than passed in as arguments. A commit subject is arbitrary text —
 * quotes, `$`, backslashes, anything anyone has ever typed after `-m` — and
 * threading it through a YAML string, a shell and an argv is four chances to
 * mangle it or to let it mean something. `execFileSync` asks git directly, with
 * no shell in between.
 *
 * Idempotent by construction: re-running for the same commit replaces that
 * commit's directory and its one manifest row, and changes nothing else. That
 * is what makes a re-run of a failed deploy safe.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { droppedCommits, nextManifest, parseManifest } from './versions-manifest.mjs'

const [archiveDir, buildDir] = process.argv.slice(2)
if (archiveDir === undefined || buildDir === undefined) {
  fail('usage: node scripts/archive-versions.mjs <archive dir> <pinned build dir>')
}
if (!existsSync(buildDir)) {
  fail(`no build at ${buildDir} — run \`npm run build:pinned\` first`)
}

/** Ask git one question, with no shell and no interpolation. */
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function fail(message) {
  process.stderr.write(`archive-versions: ${message}\n`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// The same `--short` git gives `vite.config.ts`, so the directory a build is
// published in and the commit the build reports about itself are the same
// string. They are compared at runtime — `src/ui/VersionPicker.ts` decides
// which row is selected by it — and two spellings of one commit would show a
// reader a menu with nothing selected.
const build = {
  commit: git(['rev-parse', '--short', 'HEAD']),
  version: typeof pkg.version === 'string' ? pkg.version : '',
  date: git(['log', '-1', '--format=%cI']),
  subject: git(['log', '-1', '--format=%s']),
}
if (build.commit === '') fail('could not read the commit — is this a git checkout?')

const manifestPath = join(archiveDir, 'versions.json')
const previous = existsSync(manifestPath)
  ? parseManifest(readFileSync(manifestPath, 'utf8'))
  : parseManifest('')
const next = nextManifest(previous, build)

// This build first, so that a failure between here and the manifest write
// leaves a directory nothing points at — which is invisible and cleaned up by
// the next run — rather than a manifest row pointing at a directory that is not
// there, which is a 404 offered from a menu.
const here = join(archiveDir, 'v', build.commit)
rmSync(here, { recursive: true, force: true })
mkdirSync(join(archiveDir, 'v'), { recursive: true })
cpSync(buildDir, here, { recursive: true })

const dropped = droppedCommits(previous, next)
for (const commit of dropped) rmSync(join(archiveDir, 'v', commit), { recursive: true, force: true })

writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)

const kept = next.versions.length
process.stdout.write(
  `archived ${build.commit} (${build.version}) — ${kept} build${kept === 1 ? '' : 's'} kept` +
    `${dropped.length === 0 ? '' : `, ${dropped.length} pruned: ${dropped.join(' ')}`}\n`,
)
