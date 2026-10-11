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
 *     v/<tag>/index.html     a redirect, for every release that is still kept
 *
 * The commit, its date, its subject, its tag and the package version are read
 * here rather than passed in as arguments. A commit subject is arbitrary text —
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

import {
  droppedCommits,
  droppedTags,
  isPublishableTag,
  nextManifest,
  parseManifest,
  tagAliases,
} from './versions-manifest.mjs'

const [archiveDir, buildDir] = process.argv.slice(2)
if (archiveDir === undefined || buildDir === undefined) {
  fail('usage: node scripts/archive-versions.mjs <archive dir> <pinned build dir>')
}
if (!existsSync(buildDir)) {
  fail(`no build at ${buildDir} — run \`npm run build:pinned\` first`)
}

/** Ask git one question, with no shell and no interpolation. */
function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function fail(message) {
  process.stderr.write(`archive-versions: ${message}\n`)
  process.exit(1)
}

/**
 * The tag on this commit, if there is one worth publishing.
 *
 * Locally that is one cheap question. On the runner it is not: `actions/checkout`
 * clones at depth 1 and does not fetch tags, and asking it to would drag down
 * an object for every tag in a repository that carries 250 MB of demo data in
 * its history. `ls-remote` asks the *server* for its refs — a few kilobytes of
 * names and hashes, no objects at all — which is why it is the answer here and
 * a deeper checkout is not.
 *
 * Annotated tags are advertised twice: `refs/tags/v1` is the tag object and
 * `refs/tags/v1^{}` is the commit it points at. The peeled line is the one that
 * matches a commit, and dropping the `^{}` is what turns it back into a name.
 *
 * Both halves can come back empty — a shallow checkout with no tags, a runner
 * with no network to the remote, a commit nobody tagged — and an untagged build
 * is the ordinary case rather than a problem.
 */
function tagFor(head) {
  const local = git(['tag', '--points-at', 'HEAD'])
    .split('\n')
    .map((line) => line.trim())
    .find(isPublishableTag)
  if (local !== undefined) return local
  if (head === '') return ''
  for (const line of git(['ls-remote', '--tags', 'origin']).split('\n')) {
    const [sha, ref] = line.split('\t')
    if (sha !== head || ref === undefined) continue
    const name = ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')
    if (isPublishableTag(name)) return name
  }
  return ''
}

/**
 * The page a tag alias serves: a redirect to the commit it names.
 *
 * A redirect rather than a copy of the build, because two copies of five
 * megabytes to give one of them a second name is not a trade worth making —
 * and because a copy would report the commit it was built from anyway, so the
 * only thing the second name would add is a directory that can drift.
 *
 * Both mechanisms, and they are not redundant. The script carries the query and
 * the hash across, which is the whole point — a citation of a release ought to
 * be able to name a *view* of it. The `meta refresh` is what happens with no
 * JavaScript, and it loses the hash, which is the correct order of failure: the
 * right build without the view beats a page that sits there.
 *
 * Nothing is escaped, and nothing needs to be: `isPublishableTag` allows
 * letters, digits and `._+-`, and the commit is hex. That character class is a
 * security property, not a tidiness one.
 */
function aliasPage(tag, commit) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>chromosomix ${tag}</title>
    <meta name="robots" content="noindex" />
    <!--
      Written by scripts/archive-versions.mjs — do not edit, and do not expect
      it to survive: every deploy rewrites the aliases from versions.json.
    -->
    <meta http-equiv="refresh" content="0; url=../${commit}/" />
    <script>
      // The query and the hash are the view state; a release URL that dropped
      // them would name a build and lose the figure someone was pointing at.
      location.replace('../${commit}/' + location.search + location.hash)
    </script>
  </head>
  <body>
    <p>${tag} is the build from commit <a href="../${commit}/">${commit}</a>.</p>
  </body>
</html>
`
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
  tag: tagFor(git(['rev-parse', 'HEAD'])),
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
for (const tag of droppedTags(previous, next)) {
  rmSync(join(archiveDir, 'v', tag), { recursive: true, force: true })
}

// Every alias, every time, rather than only the new one. They are a kilobyte
// each, and rewriting them is what repairs an alias left pointing at a commit
// that a re-tag moved — the alternative is a file nothing ever revisits.
const aliases = tagAliases(next)
for (const { tag, commit } of aliases) {
  mkdirSync(join(archiveDir, 'v', tag), { recursive: true })
  writeFileSync(join(archiveDir, 'v', tag, 'index.html'), aliasPage(tag, commit))
}

writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`)

const kept = next.versions.length
process.stdout.write(
  `archived ${build.commit} (${build.version}${build.tag === '' ? '' : `, tagged ${build.tag}`}) — ` +
    `${kept} build${kept === 1 ? '' : 's'} kept, ${aliases.length} release alias(es)` +
    `${dropped.length === 0 ? '' : `, ${dropped.length} pruned: ${dropped.join(' ')}`}\n`,
)
