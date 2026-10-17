/**
 * Read what `npm run build:package` actually produced, and refuse it if it is
 * wrong.
 *
 * Runs at the end of that command, which `prepack` runs — so this stands
 * between every `npm pack` and every `npm publish` and the registry. The rules
 * live in `package-shape.mjs` where a test can hold them; this file owns only
 * the walk and the exit code, the same split and for the same reason as
 * `check-pinned-build.mjs` and `check-desktop-build.mjs`.
 *
 * It exists because a published version cannot be taken back. An archived build
 * that came out wrong is rebuilt over on the next push; a tarball that came out
 * wrong is on the registry for ever, mirrored by every CDN that has seen it and
 * pinned in the lockfiles of whoever installed it that week. The pack is the
 * last moment any of it is cheap to notice — and the moment matters more here
 * than anywhere else in this repository, because `dist/` is written by two
 * builds and only one of them may be published.
 *
 * Every problem is printed, not just the first: an operator has to fix them all,
 * and a check that names one of four turns one build into four.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { packageCliProblems, packageFileProblems, packageIndexProblems } from './package-shape.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'dist')
const CLI = join(ROOT, 'dist-cli')

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
    'check-package-build: nothing at dist.\n' +
      '  Run `npm run build:package` first — this checks a build, it does not make one.',
  )
  process.exit(1)
}

const problems = packageFileProblems(files)

// `index.html` missing is its own sentence: every check below would report
// nothing at all, which reads like success.
if (files.some((file) => file.name === 'index.html')) {
  problems.push(...packageIndexProblems(readFileSync(join(OUT, 'index.html'), 'utf8')))
}

// The command the tarball's `bin` names, which `build:package` builds first.
// A directory that is not there is every file in it missing, said by name.
let cliNames = []
try {
  cliNames = readdirSync(CLI)
} catch {
  // Left empty: `packageCliProblems` names what is absent.
}
problems.push(...packageCliProblems(cliNames))

if (problems.length > 0) {
  console.error(`check-package-build: ${problems.length} problem(s) in dist\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    '\n  If these look like a *site* build: that is the one mistake this exists to catch.\n' +
      '  `npm run build` and `npm run build:package` write to the same directory, and only\n' +
      '  the second one may be published. Run it again.\n',
  )
  process.exit(1)
}

const total = files.reduce((sum, file) => sum + file.size, 0)
console.log(
  `check-package-build: ${files.length} files, ${(total / 1024 / 1024).toFixed(1)} MB, ` +
    'relative base — shape is as specified',
)
