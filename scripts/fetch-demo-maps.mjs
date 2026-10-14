#!/usr/bin/env node
/**
 * Put the published demo maps where `test/unit/demo-maps.test.ts` reads them.
 *
 * The maps are the lab's own, on a public bucket that any runner can read with
 * no credential at all — which is the point: the reader suites built over
 * `make_fixtures.py`'s output need metacooler, whose repository is private, so a
 * runner without it compared the reader against nothing. These four files are
 * maps metacooler and cooler really wrote, and `scripts/make_demo_golden.py`
 * records what the public `cooler` package reads out of them.
 *
 * Every file is checked against the size and MD5 the golden manifest recorded,
 * because a golden compared with a different file than the one it was built from
 * fails as a reader bug. Where a byte-identical copy already sits under `demo/`
 * in this checkout it is copied rather than downloaded, so a contributor's
 * machine and the always-on CI job spend no network on it; `--from s3` refuses
 * that shortcut, which is what the golden job runs so that it proves the bucket,
 * not the repository, still serves what the goldens were made from.
 *
 * Usage: `node scripts/fetch-demo-maps.mjs [--from s3]` (`npm run fixtures:demo`).
 */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { copyFile, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(REPO, 'test', 'golden', 'demo', '_manifest.json')
const OUT = join(REPO, 'test', 'fixtures', 'demo')

const fromS3 = process.argv.includes('--from') && process.argv[process.argv.indexOf('--from') + 1] === 's3'

/** MD5 of a file on disk, streamed so a 45 MB map is never held whole. */
async function md5Of(path) {
  const hash = createHash('md5')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** `true` when *path* holds exactly the bytes the golden was built from. */
async function matches(path, map) {
  if (!existsSync(path) || statSync(path).size !== map.bytes) return false
  return (await md5Of(path)) === map.md5
}

/**
 * Download one map to a temporary name and move it into place only once its
 * size and digest agree, so an interrupted transfer never leaves a truncated
 * file under the name the test opens.
 */
async function download(map, target) {
  const partial = `${target}.partial`
  const response = await fetch(map.url)
  if (!response.ok || response.body === null) {
    throw new Error(`${map.url}: HTTP ${response.status}`)
  }
  const hash = createHash('md5')
  let bytes = 0
  const counted = Readable.fromWeb(response.body).on('data', (chunk) => {
    hash.update(chunk)
    bytes += chunk.length
  })
  await pipeline(counted, createWriteStream(partial))
  const digest = hash.digest('hex')
  if (bytes !== map.bytes || digest !== map.md5) {
    await rm(partial, { force: true })
    throw new Error(
      `${map.url}: got ${bytes} bytes with MD5 ${digest}, the golden was built from ` +
        `${map.bytes} bytes with MD5 ${map.md5}`,
    )
  }
  await rename(partial, target)
}

const manifest = JSON.parse(await readFile(MANIFEST, 'utf8'))
mkdirSync(OUT, { recursive: true })

let failed = 0
for (const map of manifest.maps) {
  const target = join(OUT, map.file)
  try {
    if (await matches(target, map)) {
      console.log(`  kept        ${map.file}`)
      continue
    }
    const local = join(REPO, map.path)
    if (!fromS3 && (await matches(local, map))) {
      await copyFile(local, target)
      console.log(`  copied      ${map.file}  (from ${map.path})`)
      continue
    }
    await download(map, target)
    console.log(`  downloaded  ${map.file}  (${map.url})`)
  } catch (error) {
    failed += 1
    console.error(`  FAILED      ${map.file}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
if (failed > 0) {
  console.error(`${failed} of ${manifest.maps.length} demo maps could not be fetched`)
  process.exit(1)
}
console.log(`${manifest.maps.length} demo maps in ${OUT}`)
