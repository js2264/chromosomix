/**
 * Read what `npm run build:pinned` actually produced, and refuse it if it is
 * wrong.
 *
 * Runs at the end of that command, before the deploy job copies the directory
 * into the archive. The rules live in `pinned-shape.mjs` where a test can hold
 * them; this file owns only the walk and the exit code — the same split, for
 * the same reason, as `check-desktop-build.mjs`.
 *
 * It exists because every one of those rules fails *quietly and late*. An
 * archived build is the thing nobody opens for months: a wrong base is a blank
 * page a reader finds in November, and a `publicDir` left on is a quarter of a
 * gigabyte per commit that exhausts the site's 1 GB budget several deploys
 * after the change that caused it. The build is the last moment either is cheap
 * to notice.
 *
 * Every problem is printed, not just the first: an operator has to fix them
 * all, and a check that names one of four turns one build into four.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pinnedFileProblems, pinnedIndexProblems } from './pinned-shape.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'dist-pinned')

// The same variable the build read. Checking the output against the *input*
// rather than against a pattern is what makes this catch a build that used a
// base nobody asked for — including the default, if the guard in the config
// ever stops throwing.
const BASE = process.env.PINNED_BASE ?? ''
if (BASE === '') {
  console.error('check-pinned-build: PINNED_BASE is not set — run this through `npm run build:pinned`.')
  process.exit(1)
}

/** Every file under `dir`, with its size, relative and `/`-separated. */
function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    files.push({ name: relative(dir, full).split('\\').join('/'), size: statSync(full).size })
  }
  return files
}

let files
try {
  files = walk(OUT)
} catch {
  console.error(
    'check-pinned-build: nothing at dist-pinned.\n' +
      '  Run `npm run build:pinned` first — this checks a build, it does not make one.',
  )
  process.exit(1)
}

const problems = pinnedFileProblems(files)

// `index.html` missing is its own sentence: every check below would report
// nothing at all, which reads like success.
if (files.some((file) => file.name === 'index.html')) {
  problems.push(...pinnedIndexProblems(readFileSync(join(OUT, 'index.html'), 'utf8'), BASE))
}

if (problems.length > 0) {
  console.error(`check-pinned-build: ${problems.length} problem(s) in dist-pinned\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

const total = files.reduce((sum, file) => sum + file.size, 0)
console.log(
  `check-pinned-build: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB, ` +
    `base ${BASE} — shape is as specified`,
)
