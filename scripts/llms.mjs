/**
 * `llms-full.txt`: the README and the pages for language models as one Markdown
 * file on the site's own origin, for a reader that is a language model and
 * takes a single document rather than following links (llmstxt.org).
 *
 * Its sibling `public/llms.txt` is written by hand, because it is a summary and
 * a summary is chosen; the pages it links under `public/llms/` are generated
 * from the app and committed (`src/llms/pages.ts`); and this one is put
 * together here, because a second copy of either kept by hand would drift from
 * the first. It is the README, then every page `llms.txt` links on the site's
 * `llms/` path, in the order it links them — so adding a page to the index is
 * adding it here. The site build alone emits it, beside `llms.txt` — the builds
 * that replace the site's plugin list are copies served from elsewhere, and
 * none of them carries `public/` either.
 *
 * What changes on the way is only what has to: a link relative to the
 * repository is made absolute, since read from the site it would resolve
 * against the site — `LICENSE` and `docs/screenshot.png` are files of the
 * repository, not of `chromosomix.app`.
 */

import { readFileSync } from 'node:fs'

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

/** The plugin: `llms-full.txt` from the README and the pages, for the site build. */
export function llmsFull() {
  return {
    name: 'chromosomix-llms-full',
    apply: 'build',
    // Last in the site's list, as `thirdPartyNotices()` is and for its reason:
    // this runs after the service worker's `generateBundle` has listed what to
    // precache, and a document for a model to read is no part of working offline.
    generateBundle() {
      const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
      const index = readFileSync(new URL('../public/llms.txt', import.meta.url), 'utf8')
      const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8')
      this.emitFile({
        type: 'asset',
        fileName: 'llms-full.txt',
        source: llmsFullText(readme, index, read, repositoryUrl(manifest)),
      })
    },
  }
}
