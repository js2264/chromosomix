/**
 * Open the standalone page from a disk, and prove the app came up.
 *
 * The one check that matters and the one the shape rules cannot make. Every
 * failure mode of this target is *silent*: a module worker that cannot be
 * constructed, a chunk that cannot be fetched, a wasm that never instantiates —
 * all of them produce a page that paints its shell and then does nothing. There
 * is no error dialog and nobody is watching the console, and the person who
 * finds out is on an air-gapped machine with no way to tell you.
 *
 * So this drives a real Chromium at a real `file://` URL and asserts the
 * interface is there, no page error was thrown, and — the part that actually
 * exercises a worker — that dropping a contact map opens it.
 *
 * Not part of `npm test`. It needs `playwright-core` and a browser, which a
 * fresh clone and a CI runner may not have, and it skips with a named message
 * when they are absent — the same courtesy `real-file.test.ts` extends to the
 * data it cannot ship.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PAGE = join(ROOT, 'dist-standalone', 'index.html')

if (!existsSync(PAGE)) {
  console.error('smoke-standalone: dist-standalone/index.html is missing — run `npm run build:standalone`.')
  process.exit(1)
}

let chromium
try {
  ;({ chromium } = await import('playwright-core'))
} catch {
  console.log('smoke-standalone: skipped — playwright-core is not installed.')
  process.exit(0)
}

const EXECUTABLE =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
if (!existsSync(EXECUTABLE)) {
  console.log(`smoke-standalone: skipped — no browser at ${EXECUTABLE} (set CHROMIUM_PATH).`)
  process.exit(0)
}

const fixture = process.argv[2]
const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] })
const page = await browser.newPage()

const pageErrors = []
const consoleErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})

const problems = []
try {
  await page.goto(`file://${PAGE}`)

  // 1. The app mounted. `#app` is empty in the HTML and filled by `main.ts`.
  await page
    .waitForFunction('document.querySelector("#app")?.childElementCount > 0', null, {
      timeout: 20_000,
    })
    .catch(() => problems.push('the app never mounted into #app'))

  // 2. The drop zone is there, which is the whole interface this target offers.
  const dropzone = await page.locator('.dropzone').count()
  if (dropzone === 0) problems.push('no drop zone on the landing page')

  // 3. A worker actually started. This is the assertion the whole script exists
  //    for: everything above passes on a build whose workers cannot construct.
  if (fixture !== undefined && existsSync(fixture)) {
    await page.locator('input[type=file]').first().setInputFiles(fixture)
    const opened = await page
      .waitForFunction(
        'document.querySelector(".contigs-table, .genomes-table, canvas") !== null',
        null,
        { timeout: 40_000 },
      )
      .then(() => true)
      .catch(() => false)
    if (!opened) {
      problems.push(
        `dropping ${fixture} produced nothing — the reader worker did not answer, which is what ` +
          'a module-worker build looks like',
      )
    }
  } else if (fixture !== undefined) {
    problems.push(`fixture ${fixture} does not exist`)
  }

  // 4. Nothing threw on the way. A `file://` refusal surfaces here.
  for (const error of pageErrors) problems.push(`page error: ${error}`)
  for (const error of consoleErrors.slice(0, 5)) {
    // A failed service-worker registration is expected and handled; anything
    // else is a symptom.
    if (/service ?worker/i.test(error)) continue
    problems.push(`console error: ${error.slice(0, 200)}`)
  }
} finally {
  await browser.close()
}

if (problems.length > 0) {
  console.error('smoke-standalone: the page did not come up.')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(
  `smoke-standalone: opened from file://, mounted, and ${
    fixture === undefined ? 'no fixture was given to open' : 'read the fixture through a worker'
  }.`,
)
