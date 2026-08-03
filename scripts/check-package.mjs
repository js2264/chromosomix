/**
 * Read the packed archive, and refuse it if it is the wrong shape.
 *
 * The `files` list in `electron-builder.config.cjs` is a *claim*. This is the
 * answer: it opens every `app.asar` under `release/` and asks what is actually
 * in it. Globs are easy to get subtly wrong — a leading `**` that does not match
 * what you think, a negation ordered after the pattern it was meant to cancel —
 * and every way of getting them wrong here produces an installer that works
 * perfectly and is a quarter of a gigabyte too large, or one that is missing the
 * renderer and fails on launch.
 *
 * The size check has a **floor** as well as a ceiling, and the floor is the
 * interesting half. `!node_modules/**` is correct only for as long as the main
 * process depends on nothing outside Node's standard library. The day someone
 * adds a real dependency, the glob keeps excluding it, the app is packaged
 * without it, and the failure is a `MODULE_NOT_FOUND` on a user's machine —
 * with an archive that got *smaller*. A ceiling alone never sees it.
 */

import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listPackage } from '@electron/asar'

import { isDataFile } from './desktop-shape.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RELEASE = join(ROOT, 'release')

/** ~6 MB of application is expected; these bound the two ways that goes wrong. */
const MAX_BYTES = 40 * 1024 * 1024
const MIN_BYTES = 3 * 1024 * 1024

/** Entries every archive must contain, or the app cannot start at all. */
const REQUIRED = ['/dist-electron/main/main.cjs', '/dist-electron/renderer/index.html']

/** Every `app.asar` under `release/`, one per platform-arch that was built. */
function findArchives(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true, recursive: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'app.asar') found.push(join(entry.parentPath, entry.name))
  }
  return found
}

const archives = findArchives(RELEASE)
if (archives.length === 0) {
  console.error(
    'check-package: no app.asar under release/.\n' +
      '  Run electron-builder first — this checks a package, it does not make one.',
  )
  process.exit(1)
}

let failed = false

for (const archive of archives) {
  const where = relative(ROOT, archive)
  const problems = []

  // `listPackage` returns archive-absolute paths beginning with a separator,
  // which is why REQUIRED is written with leading slashes.
  const entries = listPackage(archive).map((entry) => entry.split('\\').join('/'))

  for (const required of REQUIRED) {
    if (!entries.includes(required)) problems.push(`missing ${required}`)
  }

  for (const entry of entries) {
    const base = entry.split('/').pop() ?? entry
    if (isDataFile(base)) problems.push(`${entry}: a data file was packaged`)
    else if (base === 'sw.js') problems.push(`${entry}: a service worker was packaged`)
    else if (base === 'manifest.webmanifest') problems.push(`${entry}: a web manifest was packaged`)
    else if (base.endsWith('.map')) problems.push(`${entry}: a source map was packaged`)
  }

  const bytes = statSync(archive).size
  const mb = (bytes / 1024 / 1024).toFixed(1)
  if (bytes > MAX_BYTES) {
    problems.push(
      `${mb} MB exceeds the ${MAX_BYTES / 1024 / 1024} MB ceiling — ` +
        'something large was swept in; compare the entry list against the files globs',
    )
  }
  if (bytes < MIN_BYTES) {
    problems.push(
      `${mb} MB is under the ${MIN_BYTES / 1024 / 1024} MB floor — ` +
        'the app is probably missing something it needs at runtime, ' +
        'most likely a dependency that `!node_modules/**/*` is still excluding',
    )
  }

  if (problems.length > 0) {
    failed = true
    console.error(`check-package: ${problems.length} problem(s) in ${where}\n`)
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error('')
  } else {
    console.log(`check-package: ${where} — ${entries.length} entries, ${mb} MB, as specified`)
  }
}

process.exit(failed ? 1 : 0)
