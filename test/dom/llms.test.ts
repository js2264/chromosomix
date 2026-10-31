// @vitest-environment jsdom
/**
 * The site's files for language models and crawlers: `llms.txt` and the pages
 * it links under `llms/`, which the app writes about itself
 * (`src/llms/render.ts`), the `llms-full.txt` the site build folds them into
 * with the README (`scripts/llms.mjs`), and `public/robots.txt` and
 * `sitemap.xml`.
 *
 * None of the first three is committed: every build of the site writes them
 * from its source, so what is deployed is what the app says. What they say is
 * held here to what the app takes, because a model acts on it — writes a link
 * from it, runs a command from it — and nothing reading it can tell a summary
 * that has drifted: each example link through the hash's own reader, each value
 * listed against the list it is drawn from, every link key against the reader's
 * own list, every flag against the parser the command reads it with, both JSON
 * examples against the parsers that will be handed them.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

import {
  absoluteLinks,
  agentFiles,
  isAgentPath,
  linkedPages,
  llmsFullText,
  repositoryUrl,
} from '../../scripts/llms.mjs'
import { taskCatalogue } from '@/analysis/catalogue'
import { TASKS, taskById } from '@/analysis/registry'
import { parseCommandLine, USAGE } from '@/cli/main'
import { publicUsage } from '@/llms/cli'
import { json, STORE_EXAMPLE, WORKSPACE_EXAMPLE } from '@/llms/data'
import { LINK_EXAMPLES, LINK_KEYS, LINK_VIEWS, UNDOCUMENTED_KEYS } from '@/llms/links'
import { AGENT_PAGES } from '@/llms/pages'
import { renderAgentFiles } from '@/llms/render'
import { synopsisOf } from '@/llms/tasks'
import { COLORMAP_NAMES } from '@/render/colormaps'
import { COMPARE_OPS } from '@/render/compare'
import { resetDevFeatures } from '@/state/devFeatures'
import { isRefusal } from '@/state/SessionConfig'
import { parseStore } from '@/state/store'
import { KEY_ORDER, parseViewState } from '@/state/ViewState'
import { parseWorkspaceFile } from '@/state/workspace'
import { builtinStores, frontById } from '@/ui/stores/registry'

// Paths rather than `new URL(…)`: under jsdom the global `URL` is jsdom's, and
// `readFileSync` does not take one of those for a file.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
/** What the site build writes, as it writes it: with the dev features off. */
const files = renderAgentFiles()
const llms = files.find((file) => file.path === 'llms.txt')?.text ?? ''
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

/**
 * Every link to the app in `text` with a view in it, opened through the hash's
 * own reader, and how many there were. Every key written has to survive the
 * reader with the value written: a key it drops, or a value it repairs, would
 * send a reader somewhere else.
 */
function opensAsWritten(text: string): number {
  const links = [...text.matchAll(/https:\/\/chromosomix\.app\/[^\s"<>`]*#uri=https?:[^\s"<>`]+/g)].map((match) => match[0])
  for (const link of links) {
    const hash = link.slice(link.indexOf('#'))
    const state = parseViewState(hash) as Record<string, unknown> | null
    expect(state, link).not.toBeNull()
    for (const part of hash.slice(1).split('&')) {
      const [key, value] = part.split('=') as [string, string]
      expect(String(state?.[key]), `${key} in ${link}`).toBe(decodeURIComponent(value))
    }
  }
  return links.length
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
    expect(opensAsWritten(concrete)).toBeGreaterThanOrEqual(3)
  })

  it('names every task the command line runs that is not a dev feature’s', () => {
    expect(listAfter('The tasks are ')).toEqual(taskCatalogue().map((task) => task.id))
  })

  it('links every page the app writes for it, in the order llms-full.txt folds them', () => {
    expect(linkedPages(llms)).toEqual(AGENT_PAGES.map((agentPage) => agentPage.path))
  })

  it('names every store the shelf offers, and no dev feature’s', () => {
    expect(listAfter('the store ids are ')).toEqual(builtinStores().map((store) => store.id))
    expect(listAfter('the store ids are ')).not.toContain('dbz')
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

describe('the pages the app writes about itself', () => {
  // As the site's own visitor reads them: the static text names no dev feature
  // (§29.5), and under `node` with no address the switch would answer on.
  beforeAll(() => resetDevFeatures(false))
  const rendered = (): Array<{ path: string; text: string }> => files

  it('are llms.txt and every page it links, each served at a path the site keeps for them', () => {
    expect(files.map((file) => file.path)).toEqual(['llms.txt', ...AGENT_PAGES.map((agentPage) => agentPage.path)])
    for (const file of files) expect(isAgentPath(file.path), file.path).toBe(true)
    expect(isAgentPath('llms-full.txt')).toBe(true)
    expect(isAgentPath('index.html')).toBe(false)
    expect(isAgentPath('llms/../index.html')).toBe(false)
  })

  it('refuse to fold a page llms.txt links that nothing writes', async () => {
    const missing = async (): Promise<Record<string, unknown>> => ({
      renderAgentFiles: () => [{ path: 'llms.txt', text: '- [Gone](https://chromosomix.app/llms/gone.md): a page' }],
    })
    await expect(agentFiles(missing)).rejects.toThrow(/llms\/gone\.md/)
  })

  it('each open with a heading and a summary, and link only to absolute https addresses', () => {
    for (const { path, text } of rendered()) {
      const lines = text.split('\n')
      expect(lines[0], path).toMatch(/^# \S/)
      expect(lines.find((line, at) => at > 0 && line !== ''), path).toMatch(/^> \S/)
      for (const [, address] of text.matchAll(/\]\(([^)]+)\)/g)) expect(address, path).toMatch(/^https:\/\//)
      // Every page named on the site is one that is served there.
      for (const [, named] of text.matchAll(/https:\/\/chromosomix\.app\/(llms\/[a-z-]+\.md)/g)) {
        expect(AGENT_PAGES.map((page) => page.path), `${path} links ${named}`).toContain(named)
      }
    }
  })

  it('open every example link where it says', () => {
    const counted = rendered().reduce((total, { text }) => total + opensAsWritten(text), 0)
    expect(counted).toBeGreaterThanOrEqual(LINK_EXAMPLES.length)
  })

  it('document every key the hash reader takes, and none it does not', () => {
    const documented = LINK_KEYS.map((entry) => entry.key)
    expect(new Set(documented).size).toBe(documented.length)
    for (const key of documented) expect(KEY_ORDER as readonly string[], key).toContain(key)
    for (const key of KEY_ORDER) expect([...documented, ...UNDOCUMENTED_KEYS], key).toContain(key)
    // In the order the app writes them, so the table reads as a link does.
    expect(documented).toEqual(KEY_ORDER.filter((key) => !UNDOCUMENTED_KEYS.includes(key)))
  })

  it('name only views the reader keeps', () => {
    for (const { view } of LINK_VIEWS) expect(parseViewState(`uri=a.cool&view=${view}`)?.view).toBe(view)
  })

  it('write every flag as the command parses it', () => {
    for (const task of taskCatalogue()) {
      for (const param of task.params) {
        // Each spelling the page offers: `--x <value>`, both halves of
        // `--x / --no-x`, and `--x=false`.
        for (const written of param.flag.split(' / ')) {
          const [name, placeholder] = written.split(' ') as [string, string | undefined]
          const values = placeholder === undefined ? [] : (param.choices?.map((choice) => choice.value) ?? ['1'])
          for (const argv of values.length === 0 ? [[name]] : values.map((value) => [name, value])) {
            const args = parseCommandLine([task.id, 'sample.cool', ...argv])
            const said = name.replace(/^--/, '').replace(/=.*$/, '')
            // A negation is filed under the switch it negates, and the command
            // line's own `--no-balance` under itself.
            expect(args.flags.has(said) || args.flags.has(param.key), `${task.id} ${argv.join(' ')}`).toBe(true)
            if (argv[1] !== undefined) expect(args.flags.get(said), `${task.id} ${argv.join(' ')}`).toContain(argv[1])
            expect(args.positional, `${task.id} ${argv.join(' ')}`).toEqual(['sample.cool'])
          }
        }
      }
      // And the command a section shows, its placeholders filled.
      const synopsis = synopsisOf(task)
        .replace(' [--<parameter> <value> …]', '')
        .replace(/\[?<map>\]?/, 'sample.cool')
        .replace(/<([a-z0-9.-]+)>/gi, '$1')
        .split(' ')
        .slice(1)
      expect(() => parseCommandLine(synopsis), synopsis.join(' ')).not.toThrow()
    }
  })

  it('list every value a choice takes, in the descriptor’s order', () => {
    for (const task of taskCatalogue()) {
      const descriptor = taskById(task.id)
      for (const param of task.params) {
        if (param.choices === undefined) continue
        const spec = descriptor?.params.find((entry) => entry.key === param.key)
        expect(spec?.kind).toBe('choice')
        const offered = spec?.kind === 'choice' ? spec.options.filter((option) => option.needsGenomes !== true) : []
        expect(param.choices.map((choice) => choice.value), `${task.id} --${param.key}`).toEqual(
          offered.map((option) => option.value),
        )
        expect(param.choices.map((choice) => choice.value)).toContain(param.default)
      }
    }
  })

  it('give the command line every task it runs when asked for the dev features too', () => {
    expect(taskCatalogue({ dev: true }).map((task) => task.id)).toEqual(TASKS.map((task) => task.id))
    expect(taskCatalogue().every((task) => taskById(task.id)?.dev === undefined)).toBe(true)
  })

  it('carry the usage whole, less the one container that is a dev feature', () => {
    expect(publicUsage()).not.toBe(USAGE)
    expect(publicUsage()).toBe(USAGE.replace('|file.metacool', ''))
  })

  it('show a store and a workspace that their parsers take whole', () => {
    // Written out as a person would write them, and still the same JSON.
    for (const example of [STORE_EXAMPLE, WORKSPACE_EXAMPLE]) expect(JSON.parse(json(example))).toEqual(example)
    const store = parseStore(json(STORE_EXAMPLE))
    expect(isRefusal(store)).toBe(false)
    if (!isRefusal(store)) {
      expect(store.entries.map((entry) => entry.label)).toEqual(STORE_EXAMPLE.entries.map((entry) => entry.label))
      expect(store.columns).toEqual(STORE_EXAMPLE.columns)
    }
    const workspace = parseWorkspaceFile(json(WORKSPACE_EXAMPLE))
    expect(isRefusal(workspace)).toBe(false)
    if (!isRefusal(workspace)) {
      expect(workspace.tabs).toHaveLength(1)
      expect(workspace.tabs[0]?.state).toEqual(WORKSPACE_EXAMPLE.tabs[0]?.state)
    }
  })
})

describe('llms-full.txt', () => {
  const repository = 'https://github.com/js2264/chromosomix'

  it('is the README, then every page llms.txt links, in its order', async () => {
    const built = await agentFiles(async () => ({ renderAgentFiles: () => files }))
    const full = built.get('llms-full.txt') ?? ''
    const text = (path: string): string => files.find((file) => file.path === path)?.text ?? ''
    expect(full).toBe(llmsFullText(read('README.md'), llms, text, repository))
    const parts = full.split('\n\n---\n\n')
    expect(parts[0]).toBe(absoluteLinks(read('README.md'), repository).replace(/\s+$/, ''))
    expect(parts.slice(1).map((part) => part.split('\n')[0])).toEqual(
      AGENT_PAGES.map((agentPage) => text(agentPage.path).split('\n')[0]),
    )
    expect(full.endsWith('\n')).toBe(true)
  })

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
