/**
 * Read what the desktop build actually produced, and refuse it if it is wrong.
 *
 * Runs at the end of `npm run build:desktop`, before anything is packaged. The
 * rules live in `desktop-shape.mjs` where a test can hold them; this file owns
 * only the walk and the exit code.
 *
 * It exists because every one of those rules fails silently. A root-absolute
 * asset URL is a blank window with nothing on any console a user will see; a
 * worker URL built from the root is a picker that renders and then hangs on the
 * first file; a demo directory swept in is an installer a quarter of a gigabyte
 * larger that works perfectly. The build is the last moment any of them is
 * cheap to notice.
 *
 * Every problem is printed, not just the first: an operator has to fix them
 * all, and a check that names one of four turns one build into four.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  entryChunkProblems,
  indexHtmlProblems,
  preloadProblems,
  rendererFileProblems,
} from './desktop-shape.mjs'
import { NOTICES_FILE } from './third-party-notices.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RENDERER = join(ROOT, 'dist-electron', 'renderer')
const PRELOAD = join(ROOT, 'dist-electron', 'main', 'preload.cjs')

/** Every file under `dir`, as paths relative to it with `/` separators. */
function walk(dir) {
  const names = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    names.push(relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/'))
  }
  return names
}

let files
try {
  files = walk(RENDERER)
} catch {
  console.error(
    `check-desktop-build: nothing at dist-electron/renderer.\n` +
      `  Run \`vite build --config vite.desktop.config.ts\` first — this checks a build, it does not make one.`,
  )
  process.exit(1)
}

const problems = [...rendererFileProblems(files)]

// The document, and then the JavaScript it pulls in. `index.html` missing is
// its own sentence: every other check below would report nothing at all, which
// reads like success.
if (!files.includes('index.html')) {
  problems.push('index.html is missing — the renderer build produced no document')
} else {
  problems.push(...indexHtmlProblems(readFileSync(join(RENDERER, 'index.html'), 'utf8')))
}

// The licences of what the renderer compiles in, which an installer is a copy of.
if (!files.includes(NOTICES_FILE)) {
  problems.push(`${NOTICES_FILE} is missing — thirdPartyNotices() did not run (scripts/third-party-notices.mjs)`)
}

// Every emitted chunk, not only the entry: Vite may split the `new Worker`
// construction into a chunk of its own, and a check that reads one file is a
// check that passes the day the bundler decides otherwise.
for (const name of files.filter((file) => file.endsWith('.js'))) {
  for (const problem of entryChunkProblems(readFileSync(join(RENDERER, name), 'utf8'))) {
    problems.push(`${name}: ${problem}`)
  }
}

// The preload lives in the main-process output rather than the renderer's, but
// it is checked here because this is the step that runs after everything is
// built, and because what it gets wrong is invisible at runtime.
try {
  problems.push(...preloadProblems(readFileSync(PRELOAD, 'utf8')))
} catch {
  problems.push('dist-electron/main/preload.cjs is missing — did scripts/build-preload.mjs run?')
}

if (problems.length > 0) {
  console.error(`check-desktop-build: ${problems.length} problem(s) in dist-electron/renderer\n`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('')
  process.exit(1)
}

console.log(`check-desktop-build: ${files.length} files, shape is as specified`)
