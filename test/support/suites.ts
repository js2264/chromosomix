/**
 * Which test files a run leaves out, and why. Read by `vitest.config.ts`, once
 * a run, before any file is collected.
 *
 * A file says it itself, on a line of its own in the comments above its
 * imports, for one of two reasons:
 *
 * - **`// @dev-feature <name> [<name>…]`** — the file tests a dev feature
 *   (SPECS §29, `src/state/devFeatures.ts`): something on `main` that a reader
 *   who has not asked for it never sees. **Left out unless the run asks for the
 *   dev features**: `npm run test:dev`, `vitest --mode dev`, or
 *   `CHROMOSOMIX_DEV_TESTS=1`. CI asks, on every push, so a dev feature is still
 *   tested like any other; a contributor's `npm test` holds the app a reader
 *   sees. The suites that test *the switch* — that switched off, a dev feature
 *   leaves nothing on screen (§29.2) — are not dev: that is what every reader
 *   gets. `test/unit/dev-tests.test.ts` holds every name here to the registry,
 *   so a feature made public cannot leave its tests out by a line nobody reads.
 * - **`// @fixtures metacooler`** — the file opens what `npm run fixtures`
 *   builds, which needs metacooler, a private repository (`.github/workflows/
 *   test.yml`). **Left out when none of those fixtures is on disk**, as on a
 *   fresh clone; run, and failing by name, as soon as any is, so that a half
 *   built set is found rather than skipped.
 *
 * What is left out is said once, at the top of the run, with the command that
 * runs it.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/** The header a marker may stand in: a file's comments come before its imports. */
const HEAD_BYTES = 4096

const DEV = /^\/\/ @dev-feature ((?:[a-z][a-z0-9-]*)(?: [a-z][a-z0-9-]*)*)\s*$/m
const FIXTURES = /^\/\/ @fixtures metacooler\s*$/m

export interface Marked {
  /** Repository-relative, with forward slashes. */
  file: string
  /** The dev features it tests, or none. */
  dev: string[]
  /** Whether it opens metacooler's fixtures. */
  fixtures: boolean
}

/** Every `*.test.ts` under `test/`, with what its header says of it. */
export function markedSuites(root: string): Marked[] {
  const out: Marked[] = []
  const dir = join(root, 'test')
  for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.test.ts') || entry.split(/[\\/]/).includes('node_modules')) continue
    const path = join(dir, entry)
    const head = readFileSync(path, 'utf8').slice(0, HEAD_BYTES)
    const dev = DEV.exec(head)?.[1].split(' ') ?? []
    out.push({ file: relative(root, path).split('\\').join('/'), dev, fixtures: FIXTURES.test(head) })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * Whether any fixture `test/golden/_manifest.json` lists is in `test/fixtures/`.
 * Any rather than all: a set built in part runs, and fails on what is missing.
 */
export function metacoolerFixturesPresent(root: string): boolean {
  const manifest = JSON.parse(readFileSync(join(root, 'test/golden/_manifest.json'), 'utf8')) as {
    fixtures: Array<{ name: string }>
  }
  return manifest.fixtures.some(({ name }) => existsSync(join(root, 'test/fixtures', name)))
}

export interface Selection {
  /** Repository-relative files to leave out of this run. */
  exclude: string[]
  /** What was left out and how to run it, or `null` when nothing was. */
  notice: string | null
}

/** What this run leaves out: dev features unless `dev`, metacooler's suites unless their fixtures are here. */
export function selectSuites(root: string, dev: boolean): Selection {
  const suites = markedSuites(root)
  const fixtures = metacoolerFixturesPresent(root)
  const devOut = dev ? [] : suites.filter((suite) => suite.dev.length > 0)
  const fixturesOut = fixtures ? [] : suites.filter((suite) => suite.fixtures && !devOut.includes(suite))
  const lines: string[] = []
  if (devOut.length > 0) {
    const features = [...new Set(devOut.flatMap((suite) => suite.dev))].sort().join(', ')
    lines.push(
      `${devOut.length} test files of dev features (${features}) not run: \`npm run test:dev\` runs them.`,
    )
  }
  if (fixturesOut.length > 0) {
    lines.push(
      `${fixturesOut.length} test files not run, for want of metacooler's fixtures: \`npm run fixtures\` ` +
        'builds them, with metacooler installed (a private repository).',
    )
  }
  return {
    exclude: [...devOut, ...fixturesOut].map((suite) => suite.file),
    notice: lines.length === 0 ? null : lines.map((line) => `chromosomix tests: ${line}`).join('\n'),
  }
}
