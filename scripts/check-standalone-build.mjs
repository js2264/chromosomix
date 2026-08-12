/**
 * Read what `npm run build:standalone` produced, and refuse it if it is wrong.
 *
 * The rules live in `standalone-shape.mjs` where a test can hold them; this file
 * owns only the walk and the exit code — the same split, for the same reason, as
 * `check-desktop-build.mjs` and `check-pinned-build.mjs`.
 *
 * It exists because every rule it enforces fails *silently*. A standalone page
 * that still references a sibling chunk opens, paints, and does nothing. One
 * built with module workers opens and looks entirely normal until somebody drops
 * a file on it. Neither produces an error anybody will see, and the person who
 * finds out is on an air-gapped machine with no way to report it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { standaloneFileProblems, standaloneIndexProblems } from './standalone-shape.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'dist-standalone')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push({ path: relative(OUT, full).split('\\').join('/'), size: statSync(full).size })
  }
  return out
}

let files
try {
  files = walk(OUT)
} catch {
  console.error('check-standalone-build: dist-standalone/ is missing — run `npm run build:standalone`.')
  process.exit(1)
}

const problems = [...standaloneFileProblems(files)]
const index = files.find((file) => file.path === 'index.html')
if (index !== undefined) {
  problems.push(...standaloneIndexProblems(readFileSync(join(OUT, 'index.html'), 'utf8')))
}

if (problems.length > 0) {
  console.error('check-standalone-build: the build is not a self-contained page.')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `check-standalone-build: one file, ${(index.size / 1024 / 1024).toFixed(1)} MB, self-contained.`,
)
