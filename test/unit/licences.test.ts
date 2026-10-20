/**
 * *About*'s list of whose work this viewer is built with (`src/licences.ts`),
 * held to what it summarises.
 *
 * `THIRD-PARTY-NOTICES.txt` is the record, and it is read off a bundle, which a
 * unit test does not have. What it can have is the same question asked of the
 * source: every package `src/` imports, everything those pull in, and every
 * upstream the notices file as copied into `src/`. A new dependency that
 * reaches a bundle without a line in *About*, or a line in the README, fails
 * here rather than being found by somebody reading a licence.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { VENDORED } from '../../scripts/third-party-notices.mjs'
import { LICENSED, noticesUrl } from '../../src/licences'

const root = fileURLToPath(new URL('../../', import.meta.url))

function sources(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...sources(path))
    else if (/\.ts$/.test(name)) found.push(path)
  }
  return found
}

/** A bare specifier's package: `echarts/core` → `echarts`, `@gmod/bbi/esm` → `@gmod/bbi`. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Every package the browser source imports. The command line's own files are
 * left out — its bundle keeps its imports external, and npm installs each with
 * its licence — and so is `node:`.
 */
function imported(): Set<string> {
  const found = new Set<string>()
  for (const file of sources(join(root, 'src'))) {
    if (file.includes('/src/cli/')) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"./][^'"]*)['"]/g)) {
      if (match[1].startsWith('node:') || match[1].startsWith('@/')) continue
      found.add(packageOf(match[1]))
    }
  }
  return found
}

/** Those packages and everything they depend on, as installed. */
function closure(start: Iterable<string>): Set<string> {
  const seen = new Set<string>()
  const queue = [...start]
  while (queue.length > 0) {
    const name = queue.pop() as string
    if (seen.has(name)) continue
    const manifest = join(root, 'node_modules', name, 'package.json')
    if (!existsSync(manifest)) continue
    seen.add(name)
    const deps = (JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> }).dependencies
    queue.push(...Object.keys(deps ?? {}))
  }
  return seen
}

const covered = new Set(LICENSED.flatMap((entry) => entry.covers))

describe("About's licences", () => {
  it('name every package the source imports, and everything those pull in', () => {
    const carried = closure(imported())
    // The packages the notices of every build have listed: if this shrinks,
    // the import scan has stopped seeing them.
    for (const name of ['three', 'echarts', 'zrender', 'h5wasm', '@gmod/bbi', 'generic-filehandle2']) {
      expect(carried).toContain(name)
    }
    expect([...carried].filter((name) => !covered.has(name))).toEqual([])
  })

  it('name every upstream copied into the source', () => {
    expect(VENDORED.map((entry: { name: string }) => entry.name).filter((name: string) => !covered.has(name))).toEqual([])
  })

  it('say what each project does here, and under which licence', () => {
    for (const entry of LICENSED) {
      expect(entry.what).not.toBe('')
      expect(entry.licence).not.toBe('')
      expect(entry.url).toMatch(/^https:\/\//)
    }
  })

  it('are the README’s too', () => {
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const section = readme.slice(readme.indexOf('## Licence'))
    expect(section.startsWith('## Licence')).toBe(true)
    const body = section.slice(0, section.indexOf('\n## ', 1) === -1 ? undefined : section.indexOf('\n## ', 1))
    for (const name of covered) expect(body.toLowerCase()).toContain(name.toLowerCase())
  })

  it('link the notices beside the page', () => {
    expect(noticesUrl()).toMatch(/THIRD-PARTY-NOTICES\.txt$/)
  })
})
