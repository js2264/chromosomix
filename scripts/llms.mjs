/**
 * The files the site serves to language models — `llms.txt`, the reference
 * pages it links under `llms/`, and `llms-full.txt` — written by the site build
 * from the source it is building, and served by the dev server on request
 * (SPECS §11, llmstxt.org).
 *
 * `llms.txt` and the pages are the app's to write (`src/llms/render.ts`): the
 * tasks from the registry, the link keys from the hash reader, the usage from
 * the command, and so on. They are TypeScript, which a Vite config cannot
 * import as it stands, so the build loads them the way the dev server loads any
 * module for SSR — through a Vite server of its own, made for the purpose and
 * closed after — and the dev server through itself. Nothing generated is kept
 * in the repository: every deploy of `main` serves what that commit's app says,
 * and a pull request's build (`.github/workflows/test.yml`) fails if the pages
 * cannot be written.
 *
 * `llms-full.txt` is put together here: the README, its repository-relative
 * links made absolute — read from the site they would resolve against the site,
 * and `LICENSE` and `docs/screenshot.png` are files of the repository, not of
 * `chromosomix.app` — then each page `llms.txt` links on the site's `llms/`
 * path, in the order it links them.
 *
 * Only the site build carries this plugin; the builds that replace its plugin
 * list are copies served from elsewhere.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The repository, as a path. Joined rather than resolved with `new URL(…)`: a
 * test under jsdom has jsdom's `URL`, which `readFileSync` does not take.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The repository's address from a `package.json`: `git+…` and `….git` unwound. */
export function repositoryUrl(manifest) {
  const raw = typeof manifest.repository === 'string' ? manifest.repository : (manifest.repository?.url ?? '')
  return raw.replace(/^git\+/, '').replace(/\.git$/, '')
}

/**
 * `markdown` with every repository-relative link and image made absolute: a link
 * to the file on GitHub, an image to its raw bytes. A link with a scheme, an
 * anchor or a root-absolute path is left as it is.
 */
export function absoluteLinks(markdown, repository, ref = 'main') {
  const page = `${repository}/blob/${ref}/`
  const raw = `${repository.replace('://github.com/', '://raw.githubusercontent.com/')}/${ref}/`
  const relative = '(?![a-z][a-z0-9+.-]*:|#|/)'
  return markdown
    .replace(new RegExp(`\\]\\(${relative}([^)\\s]+)\\)`, 'gi'), (_match, path) => `](${page}${path})`)
    .replace(new RegExp(`(\\ssrc=")${relative}([^"]+)"`, 'gi'), (_match, attribute, path) => `${attribute}${raw}${path}"`)
}

/** The site's pages that `index` (an `llms.txt`) links, as paths under the site's root, in order. */
export function linkedPages(index) {
  return [...index.matchAll(/\]\(https:\/\/chromosomix\.app\/(llms\/[a-z0-9-]+\.md)\)/g)].map((match) => match[1])
}

/**
 * The whole of `llms-full.txt`: the README with its links made absolute, then
 * each page `index` links, read by `read(path)`, a rule between each.
 */
export function llmsFullText(readme, index, read, repository) {
  const parts = [absoluteLinks(readme, repository), ...linkedPages(index).map((path) => read(path))]
  return `${parts.map((part) => part.replace(/\s+$/, '')).join('\n\n---\n\n')}\n`
}

/** The module that renders the app's files, as a Vite server addresses it. */
const ENTRY = '/src/llms/render.ts'

/** Whether a path under the site's root is one of these files. */
export function isAgentPath(path) {
  return path === 'llms.txt' || path === 'llms-full.txt' || /^llms\/[a-z0-9-]+\.md$/.test(path)
}

/**
 * Every file, by the path it is served at: what the app renders, through
 * `load` — a Vite server's `ssrLoadModule` — and `llms-full.txt` after them.
 * A page `llms.txt` links that nothing writes is an error, not a gap in the
 * file that folds them.
 */
export async function agentFiles(load) {
  const { renderAgentFiles } = await load(ENTRY)
  const files = new Map(renderAgentFiles().map((file) => [file.path, file.text]))
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const read = (path) => {
    const text = files.get(path)
    if (text === undefined) throw new Error(`llms.txt links ${path}, which nothing writes`)
    return text
  }
  files.set('llms-full.txt', llmsFullText(readme, files.get('llms.txt'), read, repositoryUrl(manifest)))
  return files
}

/**
 * The files, from a Vite server made for it and closed after: no config file,
 * which would bring this plugin back in, and nothing but the alias the source
 * is written against.
 */
export async function buildAgentFiles() {
  const { createServer } = await import('vite')
  const server = await createServer({
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    appType: 'custom',
    resolve: { alias: { '@': join(ROOT, 'src') } },
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  try {
    return await agentFiles((id) => server.ssrLoadModule(id))
  } finally {
    await server.close()
  }
}

/** The plugin, for the site build and its dev server. */
export function llms() {
  return {
    name: 'chromosomix-llms',
    // The dev server renders each file when it is asked for, through its own
    // module graph, so an edit to a task shows on the next request.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const base = server.config.base
        const url = (req.url ?? '').split('?')[0] ?? ''
        if (!url.startsWith(base)) return next()
        const path = decodeURIComponent(url.slice(base.length))
        if (!isAgentPath(path)) return next()
        agentFiles((id) => server.ssrLoadModule(id)).then((files) => {
          const text = files.get(path)
          if (text === undefined) return next()
          res.setHeader('Content-Type', `${path.endsWith('.md') ? 'text/markdown' : 'text/plain'}; charset=utf-8`)
          res.end(text)
        }, next)
      })
    },
    // Last in the site's list, as `thirdPartyNotices()` is and for its reason:
    // this runs after the service worker's `generateBundle` has listed what to
    // precache, and a document for a model to read is no part of working offline.
    async generateBundle() {
      for (const [fileName, source] of await buildAgentFiles()) this.emitFile({ type: 'asset', fileName, source })
    },
  }
}
