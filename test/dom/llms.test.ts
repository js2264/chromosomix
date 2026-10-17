// @vitest-environment jsdom
/**
 * The site's files for language models and crawlers: `public/llms.txt`,
 * `robots.txt` and `sitemap.xml`, and the `llms-full.txt` the site build writes
 * from the README (`scripts/llms.mjs`).
 *
 * `llms.txt` is written by hand and read by models that act on it — they write
 * a link from it, or run a command from it — so everything it says the app takes
 * is held to what the app takes: each example link through the hash's own
 * reader, each value it lists against the list it is drawn from, each task
 * against the registry and each store against the shelf. A summary that has
 * drifted from the app is worse than none, since nothing reading it can tell.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { absoluteLinks, repositoryUrl } from '../../scripts/llms.mjs'
import { taskById } from '@/analysis/registry'
import { COLORMAP_NAMES } from '@/render/colormaps'
import { COMPARE_OPS } from '@/render/compare'
import { parseViewState } from '@/state/ViewState'
import { frontById } from '@/ui/stores/registry'

// Paths rather than `new URL(…)`: under jsdom the global `URL` is jsdom's, and
// `readFileSync` does not take one of those for a file.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const llms = read('public/llms.txt')
const lines = llms.split('\n')

/** The backticked words of the first sentence of the bullet that documents `key`. */
function valuesOf(key: string): string[] {
  const line = lines.find((text) => text.startsWith(`- \`${key}\``)) ?? ''
  expect(line, `llms.txt documents \`${key}\``).not.toBe('')
  const sentence = line.slice(line.indexOf(':') + 1).split(/\.\s/)[0] ?? ''
  return [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string)
}

/** The backticked words of the sentence that `opening` starts. */
function listAfter(opening: string): string[] {
  const at = llms.indexOf(opening)
  expect(at, `llms.txt says "${opening}"`).toBeGreaterThan(-1)
  const sentence = llms.slice(at + opening.length).split(/\.(\s|$)/)[0] ?? ''
  return [...sentence.matchAll(/`([^`]+)`/g)].map((match) => match[1] as string)
}

describe('llms.txt', () => {
  it('has the shape llmstxt.org gives it', () => {
    expect(lines[0]).toBe('# chromosomix')
    expect(lines.find((text) => text !== '' && !text.startsWith('#'))).toMatch(/^> /)
    // Headings are the H1 and the sections of links, nothing deeper.
    expect(lines.filter((text) => /^#{3,} /.test(text))).toEqual([])
    const sections = lines.filter((text) => text.startsWith('## '))
    expect(sections.length).toBeGreaterThan(1)
    expect(sections.at(-1)).toBe('## Optional')
    // Under the first section, only links: `- [name](address): what it is`.
    const listed = lines.slice(lines.indexOf(sections[0] as string)).filter((text) => text !== '' && !text.startsWith('## '))
    for (const text of listed) expect(text).toMatch(/^- \[[^\]]+\]\(https:\/\/[^)]+\)(: .+)?$/)
  })

  it('links only to absolute https addresses, since it is read away from the site', () => {
    for (const [, address] of llms.matchAll(/\]\(([^)]+)\)/g)) expect(address).toMatch(/^https:\/\//)
  })

  it('opens every example link where it says, through the hash the app reads', () => {
    // The template too, its placeholders filled: it is the link a model copies most.
    const concrete = llms
      .replaceAll('<file URL>', 'https://example.org/sample.cool')
      .replaceAll('<sequence>:<start>-<end>', 'I:0-1000')
    const links = [...concrete.matchAll(/https:\/\/chromosomix\.app\/[^\s"<>]*#uri=https?:[^\s"<>]+/g)].map((match) => match[0])
    expect(links.length).toBeGreaterThanOrEqual(3)
    for (const link of links) {
      const hash = link.slice(link.indexOf('#'))
      const state = parseViewState(hash) as Record<string, unknown> | null
      expect(state, link).not.toBeNull()
      // Every key written survives the reader with the value written: a key it
      // drops, or a value it repairs, would send a reader somewhere else.
      for (const part of hash.slice(1).split('&')) {
        const [key, value] = part.split('=') as [string, string]
        expect(String(state?.[key]), `${key} in ${link}`).toBe(decodeURIComponent(value))
      }
    }
  })

  it('names only views, transforms, colour maps and comparisons the app has, and every colour map', () => {
    for (const view of valuesOf('view')) expect(parseViewState(`uri=a.cool&view=${view}`)?.view).toBe(view)
    for (const transform of valuesOf('transform')) {
      expect(parseViewState(`uri=a.cool&transform=${transform}`)?.transform).toBe(transform)
    }
    expect(new Set(valuesOf('colormap'))).toEqual(new Set(COLORMAP_NAMES))
    expect(new Set(listAfter('`op` is '))).toEqual(new Set(COMPARE_OPS))
  })

  it('names tasks the command line runs, and no dev feature’s', () => {
    const tasks = listAfter('The tasks are ')
    expect(tasks.length).toBeGreaterThan(10)
    for (const id of tasks) {
      const task = taskById(id)
      expect(task, id).toBeDefined()
      expect(task?.dev, id).toBeUndefined()
    }
  })

  it('names stores the shelf has', () => {
    const stores = listAfter('the store ids are ')
    expect(stores.length).toBeGreaterThan(3)
    for (const id of stores) expect(frontById(id), id).not.toBeNull()
  })
})

describe('robots.txt and sitemap.xml', () => {
  const robots = read('public/robots.txt')
  const sitemap = read('public/sitemap.xml')

  it('let every crawler in, keep the frozen copies out, and name the sitemap', () => {
    expect(robots).toMatch(/^User-agent: \*$/m)
    expect(robots).toMatch(/^Allow: \/$/m)
    // Each of these holds a copy of the app, for links that must not change.
    expect(robots).toMatch(/^Disallow: \/v\/$/m)
    expect(robots).toMatch(/^Disallow: \/pr\/$/m)
    expect(robots).not.toMatch(/^Disallow: \/\s*$/m)
    expect(robots).toMatch(/^Sitemap: https:\/\/chromosomix\.app\/sitemap\.xml$/m)
  })

  it('list the site’s pages, as well-formed XML', () => {
    const document = new DOMParser().parseFromString(sitemap, 'application/xml')
    expect(document.getElementsByTagName('parsererror')).toHaveLength(0)
    const pages = [...document.getElementsByTagName('loc')].map((element) => element.textContent)
    expect(pages).toContain('https://chromosomix.app/')
    for (const page of pages) expect(page).toMatch(/^https:\/\/chromosomix\.app\//)
  })
})

describe('llms-full.txt', () => {
  const repository = 'https://github.com/js2264/chromosomix'

  it('reads the repository out of package.json', () => {
    expect(repositoryUrl({ repository: { url: 'git+https://github.com/js2264/chromosomix.git' } })).toBe(repository)
    expect(repositoryUrl(JSON.parse(read('package.json')))).toBe(repository)
  })

  it('makes a repository-relative link absolute, and leaves every other alone', () => {
    const text = [
      'See [the licence](LICENSE) and [a folder](licenses/).',
      '<img src="docs/screenshot.png" alt="x">',
      '[site](https://chromosomix.app/) [anchor](#licence) [root](/v/) <img src="https://x.org/a.png">',
    ].join('\n')
    expect(absoluteLinks(text, repository)).toBe(
      [
        `See [the licence](${repository}/blob/main/LICENSE) and [a folder](${repository}/blob/main/licenses/).`,
        '<img src="https://raw.githubusercontent.com/js2264/chromosomix/main/docs/screenshot.png" alt="x">',
        '[site](https://chromosomix.app/) [anchor](#licence) [root](/v/) <img src="https://x.org/a.png">',
      ].join('\n'),
    )
  })

  it('leaves no relative link in the README it serves', () => {
    const served = absoluteLinks(read('README.md'), repository)
    expect([...served.matchAll(/\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi)].map((match) => match[1])).toEqual([])
    expect([...served.matchAll(/\ssrc="(?![a-z][a-z0-9+.-]*:)([^"]+)"/gi)].map((match) => match[1])).toEqual([])
  })
})
