/**
 * Put a built copy of the documentation into the published site (SPECS §32):
 * a checkout of the `gh-pages` branch of js2264/chromosomix-docs, which GitHub
 * Pages serves at doc.chromosomix.app. Run by `.github/workflows/docs.yml`,
 * which then commits the result and pushes it.
 *
 *   node scripts/docs-publish.mjs <site> --dev <built> --commit <sha> --date <iso>
 *   node scripts/docs-publish.mjs <site> --release v0.20.0 <built> --root <built for the root> \
 *        --commit <sha> --date <iso>
 *
 * `--dev` replaces `/dev/` with main's copy. `--release` replaces `/<tag>/`
 * with that release's copy and, when it is the latest release — the highest
 * version, which a fix for an older line is not — the root with the copy built
 * for the root. Either way the manifest, `CNAME`, `.nojekyll` and `robots.txt`
 * are written again, so the branch is always a whole site whatever it held
 * before. The rules are `docs-versions.mjs`'s.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  DEV,
  DOMAIN,
  collisions,
  isRelease,
  parseManifest,
  robotsTxt,
  rootBeforeFirstRelease,
  rootCopyEntries,
  serialise,
  withDev,
  withRelease,
} from './docs-versions.mjs'

function usage(message) {
  console.error(`docs-publish: ${message}`)
  console.error('usage: docs-publish.mjs <site> (--dev <built> | --release <tag> <built> --root <built>) --commit <sha> --date <iso>')
  process.exit(2)
}

function parse(argv) {
  const [site, ...rest] = argv
  if (site === undefined || site.startsWith('--')) usage('name the checkout of the published site first')
  const options = { site: resolve(site) }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    const value = () => {
      const next = rest[index + 1]
      if (next === undefined || next.startsWith('--')) usage(`${flag} needs a value`)
      index += 1
      return next
    }
    switch (flag) {
      case '--dev':
        options.dev = resolve(value())
        break
      case '--release':
        options.release = value()
        options.built = resolve(value())
        break
      case '--root':
        options.root = resolve(value())
        break
      case '--commit':
        options.commit = value()
        break
      case '--date':
        options.date = value()
        break
      default:
        usage(`unknown flag ${flag}`)
    }
  }
  if ((options.dev === undefined) === (options.release === undefined)) usage('say --dev or --release, once')
  if (options.release !== undefined && !isRelease(options.release)) usage(`${options.release} is not a release tag (v<major>.<minor>.<patch>)`)
  if (options.release !== undefined && options.root === undefined) usage('a release needs --root, its copy built for the root')
  for (const path of [options.dev, options.built, options.root]) {
    if (path !== undefined && !existsSync(join(path, 'index.html'))) usage(`${path} holds no built copy (no index.html)`)
  }
  return options
}

/** Replace `site/<name>/` with a copy of `built`. */
function replaceDirectory(site, name, built) {
  const target = join(site, name)
  rmSync(target, { recursive: true, force: true })
  cpSync(built, target, { recursive: true })
}

/** Refuse a root copy that would land on a copy's directory or one of the site's files, before anything is written. */
function checkRoot(built) {
  const clashes = collisions(readdirSync(built))
  if (clashes.length > 0) throw new Error(`the root copy would overwrite ${clashes.join(', ')}; a page or file at the root may not take a copy's or the site's name`)
}

/** Replace the root copy: everything at the root but the copies and the site's files. */
function replaceRoot(site, built) {
  for (const name of rootCopyEntries(readdirSync(site))) rmSync(join(site, name), { recursive: true, force: true })
  for (const name of readdirSync(built)) cpSync(join(built, name), join(site, name), { recursive: true })
}

function main() {
  const options = parse(process.argv.slice(2))
  mkdirSync(options.site, { recursive: true })
  const manifestPath = join(options.site, 'versions.json')
  let manifest = parseManifest(existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '')

  if (options.dev !== undefined) {
    replaceDirectory(options.site, DEV, options.dev)
    manifest = withDev(manifest, { commit: options.commit, date: options.date })
    console.log(`docs-publish: /${DEV}/ is main's copy from ${options.commit ?? 'an unnamed commit'}`)
  } else {
    checkRoot(options.root)
    replaceDirectory(options.site, options.release, options.built)
    manifest = withRelease(manifest, { version: options.release, commit: options.commit, date: options.date })
    if (manifest.latest === options.release) {
      replaceRoot(options.site, options.root)
      console.log(`docs-publish: /${options.release}/ published, and the root is its copy: it is the latest release`)
    } else {
      console.log(`docs-publish: /${options.release}/ published; the root stays ${manifest.latest}'s, the latest release`)
    }
  }

  // Before the first release the root has no copy of its own: it sends a reader to main's.
  if (manifest.latest === null) {
    for (const name of rootCopyEntries(readdirSync(options.site))) rmSync(join(options.site, name), { recursive: true, force: true })
    writeFileSync(join(options.site, 'index.html'), rootBeforeFirstRelease())
  }

  writeFileSync(manifestPath, serialise(manifest))
  writeFileSync(join(options.site, 'CNAME'), `${DOMAIN}\n`)
  writeFileSync(join(options.site, '.nojekyll'), '')
  writeFileSync(join(options.site, 'robots.txt'), robotsTxt())
  console.log(
    `docs-publish: ${manifest.releases.length} release${manifest.releases.length === 1 ? '' : 's'} (latest ${manifest.latest ?? 'none yet'})` +
      `${manifest.dev === null ? '' : ', and main'}`,
  )
}

try {
  main()
} catch (error) {
  console.error(`docs-publish: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
