// @vitest-environment jsdom
/**
 * The generated stores are read from the site the page is on, under `stores/`, and
 * from nowhere else: same origin, so no CORS enters into it, and a private
 * repository changes nothing — the reason they are no longer read off the
 * `stores` branch through `raw.githubusercontent.com` (SPECS §24.3).
 *
 * And the list is checked against the generator's, which is the other thing
 * this file is for. ENCODE is published as twelve shards because the whole of
 * it is 1.2 million rows, and the shard ids live in two places that cannot
 * import each other: `scripts/make_store.py` writes them and `src/ui/examples.ts`
 * ships a reference to each. A name that drifted would be a menu entry that
 * answers 404 for a file that exists under another name — and the picker would
 * report it as *not generated yet*, which is the one failure mode that looks
 * like a normal state.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { builtinStores, STORE_GROUPS } from '@/ui/examples'

// `process.cwd()` rather than `import.meta.url`: this suite runs in jsdom,
// where a module's own URL is an `http://localhost/` one and `readFileSync`
// refuses it. Vitest runs from the repository root, which is the one path both
// environments agree on.
const GENERATOR = readFileSync(join(process.cwd(), 'scripts', 'make_store.py'), 'utf8')

/**
 * The shard ids `make_store.py` writes, read out of its source.
 *
 * Reading the Python rather than running it, because what is being checked is
 * the *list* and not the generator: a test that ran the script would need a
 * network, a portal and a gigabyte of manifest to answer a question about two
 * tuples.
 */
function generatorShards(): string[] {
  const assemblies = /ENCODE_SHARDS = tuple\([\s\S]*?for assembly in \(([^)]*)\)/.exec(GENERATOR)
  const categories = /ENCODE_SHARDS = tuple\([\s\S]*?for category in \(([^)]*)\)/.exec(GENERATOR)
  expect(assemblies, 'ENCODE_SHARDS moved in make_store.py').not.toBeNull()
  expect(categories, 'ENCODE_SHARDS moved in make_store.py').not.toBeNull()
  const names = (match: RegExpExecArray | null): string[] =>
    [...(match?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((one) => one[1])
  return names(assemblies).flatMap((assembly) =>
    names(categories).map((category) => `${assembly}-${category}`),
  )
}

describe('the generated stores, on a page', () => {
  it('are read from this site, under stores/', () => {
    const site = new URL(window.location.href).origin
    for (const id of ['igv', '4dn', 'encode-GRCh38-signal', 'igv-sessions']) {
      const ref = builtinStores().find((held) => held.id === id)
      expect(ref?.url, `the ${id} store`).toBe(`${site}/stores/${id}.json`)
    }
  })

  it('ships one reference per shard the generator writes, and no others', () => {
    const shipped = builtinStores()
      .filter((ref) => ref.id.startsWith('encode-') && !ref.id.endsWith('-sessions'))
      .map((ref) => ref.id.slice('encode-'.length))
    expect(shipped).toEqual(generatorShards())
  })

  it('files every shelf under a heading, so eighteen options read as five lists', () => {
    const stores = builtinStores()
    // Every one of them, and not "most": an ungrouped reference falls back to
    // *Built in* in the table, which for an ENCODE shard would be a silent
    // wrong answer rather than a visible one.
    expect(stores.every((ref) => ref.group !== undefined)).toBe(true)
    const headings = [...new Set(stores.map((ref) => ref.group))]
    expect(headings).toEqual([
      STORE_GROUPS.builtin,
      STORE_GROUPS.igv,
      STORE_GROUPS.fourdn,
      STORE_GROUPS.encode,
      STORE_GROUPS.sessions,
    ])
  })

  it('costs no request: one inline store, and a URL for every other', () => {
    const stores = builtinStores()
    expect(stores.filter((ref) => ref.store !== undefined).map((ref) => ref.id)).toEqual(['demos'])
    for (const ref of stores) {
      expect(ref.builtin).toBe(true)
      expect(ref.store !== undefined || ref.url !== undefined).toBe(true)
    }
  })
})
