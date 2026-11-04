/**
 * Report test coverage over the whole app, one row per area of the source.
 *
 * Reads `coverage/coverage-summary.json`, which a run with `--coverage` writes
 * (vitest.config.ts says over which files, and why every one of them counts
 * whether a test loads it or not), and prints a Markdown table: the app as a
 * whole, then each directory under `src/`, the files at the top of `src/`
 * together, and `electron/`, largest first. On a GitHub runner the same table
 * is appended to the job's summary, so a run's coverage is on its page rather
 * than in a log nobody opens.
 *
 * Per area rather than per file because six hundred rows is a report nobody
 * reads, and one figure for the app hides which half of it the tests are
 * about. The file-by-file view is the HTML report beside the summary, at
 * `coverage/index.html`.
 *
 * *Not loaded* counts the files with code in them and not one line run: the
 * files no test imports, directly or through anything else.
 *
 *   node scripts/coverage-summary.mjs [--title <which run>] [--dir <reports>] [--badge <file>]
 *
 * `--dir` defaults to `COVERAGE_DIR`, then `coverage/`, as vitest.config.ts's
 * does, so a run that moved its reports finds them without being told twice.
 *
 * `--badge` also writes the app's line coverage as a shields.io endpoint — the
 * JSON `img.shields.io/endpoint?url=…` draws a badge from — which the Tests
 * workflow publishes at `<site>/coverage/badge.json`, beside the report it
 * summarises, and the README's badge reads (docs/deploy.md).
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    title: { type: 'string' },
    dir: { type: 'string', default: process.env.COVERAGE_DIR || 'coverage' },
    badge: { type: 'string' },
  },
})

const root = resolve(new URL('..', import.meta.url).pathname)
const summaryPath = resolve(root, values.dir, 'coverage-summary.json')

let summary
try {
  summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
} catch {
  console.error(
    `No coverage summary at ${relative(process.cwd(), summaryPath)}: run the tests with --coverage first ` +
      '(npm run test:coverage, or npm run test:nofixtures -- --coverage).',
  )
  process.exit(1)
}

const METRICS = ['lines', 'branches', 'functions']

const empty = () => ({
  files: 0,
  notLoaded: 0,
  ...Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0 }])),
})

// The checkout the run measured, which need not be this one — a report made in
// a copy elsewhere is read here as well: the deepest directory every file is
// under, which is the checkout itself, since every run counts both `src/` and
// `electron/` (vitest.config.ts), or one of the two if a report holds one only.
const files = Object.keys(summary).filter((file) => file !== 'total')
let base = dirname(files[0] ?? root)
for (const file of files) {
  while (base !== dirname(base) && !file.startsWith(base + sep)) base = dirname(base)
}
if (['src', 'electron'].includes(basename(base))) base = dirname(base)

/** `src/ui/stores/x.ts` → `src/ui/`, `src/main.ts` → `src/*`, `electron/main.cts` → `electron/`. */
function areaOf(file) {
  const parts = relative(base, file).split(sep)
  if (parts.length === 2) return `${parts[0]}/*`
  if (parts[0] === 'src') return `src/${parts[1]}/`
  return `${parts[0]}/`
}

const all = empty()
const areas = new Map()
for (const file of files) {
  const numbers = summary[file]
  const area = areas.get(areaOf(file)) ?? empty()
  areas.set(areaOf(file), area)
  const neverRun = numbers.lines.total > 0 && numbers.lines.covered === 0
  for (const into of [all, area]) {
    into.files += 1
    if (neverRun) into.notLoaded += 1
    for (const m of METRICS) {
      into[m].total += numbers[m].total
      into[m].covered += numbers[m].covered
    }
  }
}

const count = (n) => n.toLocaleString('en-GB')
const pct = ({ total, covered }) => (total === 0 ? '—' : `${((100 * covered) / total).toFixed(1)}%`)

const row = (name, a) =>
  `| ${name} | ${count(a.files)} | ${count(a.notLoaded)} | ${pct(a.lines)} | ` +
  `${count(a.lines.covered)} / ${count(a.lines.total)} | ${pct(a.branches)} | ${pct(a.functions)} |`

const table = [
  `## Test coverage${values.title ? `: ${values.title}` : ''}`,
  '',
  '| | files | not loaded | lines | lines run / total | branches | functions |',
  '|---|---:|---:|---:|---:|---:|---:|',
  row('**the app**', all),
  ...[...areas]
    .sort(([, a], [, b]) => b.lines.total - a.lines.total)
    .map(([name, a]) => row(`\`${name}\``, a)),
  '',
].join('\n')

console.log(table)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`)

if (values.badge) {
  const lines = all.lines.total === 0 ? 0 : (100 * all.lines.covered) / all.lines.total
  // Red under a half, then a step every ten points to bright green at ninety.
  const color =
    lines >= 90 ? 'brightgreen' : lines >= 80 ? 'green' : lines >= 70 ? 'yellowgreen' : lines >= 60 ? 'yellow' : lines >= 50 ? 'orange' : 'red'
  const badge = { schemaVersion: 1, label: 'coverage', message: `${lines.toFixed(1)}%`, color }
  writeFileSync(resolve(process.cwd(), values.badge), `${JSON.stringify(badge)}\n`)
  console.log(`Badge: ${badge.message} (${color}) → ${values.badge}`)
}
