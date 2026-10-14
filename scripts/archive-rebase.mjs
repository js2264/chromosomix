/**
 * Move every archived build and preview to the site's current base.
 *
 * Run by `.github/workflows/deploy.yml` right after it fetches the archive, so
 * that the builds published beside the site are built for the place they are
 * served from. Every deploy runs it and almost every run does nothing: a build
 * already at the site's base is left byte for byte as it was. It changes
 * something only on the deploy after the site moves — to a custom domain
 * (`public/CNAME`), to a renamed repository, to a `BASE_PATH` — and the
 * archive branch then keeps the result, so it happens once.
 *
 *     node scripts/archive-rebase.mjs <archive dir> <site base>
 *
 * The rules are in `archive-base.mjs`, where a test holds them; the walk is
 * here. A build whose own `index.html` does not say what it was built for is
 * reported and left alone rather than guessed at.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { ARCHIVE_KINDS, bakedSiteBase, isBuildDirectory, isTextAsset, rebaseText } from './archive-base.mjs'

const [archiveDir, siteBase] = process.argv.slice(2)
if (archiveDir === undefined || siteBase === undefined) {
  fail('usage: node scripts/archive-rebase.mjs <archive dir> <site base>')
}
if (!/^\/(?:[\w.-]+\/)*$/.test(siteBase)) {
  fail(`the site base must look like / or /<path>/ — got ${JSON.stringify(siteBase)}`)
}

function fail(message) {
  process.stderr.write(`archive-rebase: ${message}\n`)
  process.exit(1)
}

/** Every file under `dir`, recursively. */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

let moved = 0
let files = 0
for (const kind of ARCHIVE_KINDS) {
  const root = join(archiveDir, kind)
  if (!existsSync(root)) continue
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name)
    if (!isBuildDirectory(kind, name) || !statSync(dir).isDirectory()) continue
    const index = join(dir, 'index.html')
    if (!existsSync(index)) {
      process.stdout.write(`  ${kind}/${name}: no index.html — left alone\n`)
      continue
    }
    const from = bakedSiteBase(readFileSync(index, 'utf8'), kind, name)
    if (from === null) {
      process.stdout.write(`  ${kind}/${name}: its index.html names no base — left alone\n`)
      continue
    }
    if (from === siteBase) continue
    let changed = 0
    for (const path of walk(dir)) {
      if (!isTextAsset(path)) continue
      const text = readFileSync(path, 'utf8')
      const next = rebaseText(text, { from, to: siteBase, kind, name })
      if (next === text) continue
      writeFileSync(path, next)
      changed += 1
    }
    moved += 1
    files += changed
    process.stdout.write(
      `  ${kind}/${name}: ${from} → ${siteBase} (${changed} file${changed === 1 ? '' : 's'}, ${relative(archiveDir, dir)})\n`,
    )
  }
}

process.stdout.write(
  moved === 0
    ? `archive-rebase: every build is already at ${siteBase}\n`
    : `archive-rebase: moved ${moved} build${moved === 1 ? '' : 's'} to ${siteBase}, ${files} file${files === 1 ? '' : 's'} rewritten\n`,
)
