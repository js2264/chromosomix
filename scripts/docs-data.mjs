/**
 * Everything the documentation site (`documentation/`, SPECS §32) reads from
 * the app, written where the site reads it. Run before every build of the site:
 *
 *   node scripts/docs-data.mjs            # a build of `main`: the unreleased notes included
 *   DOCS_VERSION=v0.20.0 node scripts/docs-data.mjs   # a release's build
 *
 * It writes, and nothing it writes is committed (`.gitignore`):
 *
 *   documentation/src/generated/data.json      the tasks, from the registry, with their methods,
 *                                              validation sections, commands and every parameter
 *   documentation/src/generated/tokens.css     the app's colour, type and shape tokens, from
 *                                              `src/ui/styles.css`, for the site's theme
 *   documentation/src/generated/mark.png       the app's mark, the 192 px icon the app shows, and
 *   documentation/public/favicon.png           the same file as the site's icon
 *   documentation/src/content/docs/reference/  the reference pages the site serves to language
 *                                              models (`src/llms/`), as pages of the site
 *   documentation/src/content/docs/releases/   one page per release, from `CHANGELOG.md`
 *
 * The app's half is `src/documentation/data.ts`, loaded here the way
 * `scripts/llms.mjs` loads `llms/render.ts`: through a Vite server made for the
 * purpose, with no config file and nothing but the alias the source is written
 * against, and closed after.
 *
 * The functions that read a file — the changelog, the stylesheet, the
 * validation notebook — are exported for `test/unit/docs-data.test.ts`.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { absoluteLinks, repositoryUrl } from './llms.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SITE = join(ROOT, 'documentation')
const GENERATED = join(SITE, 'src', 'generated')
const CONTENT = join(SITE, 'src', 'content', 'docs')

/** Where the rendered validation notebook is published, beside the app. */
export const VALIDATION_URL = 'https://chromosomix.app/validation/'

/**
 * The identifier pandoc gives a heading, which is what Quarto writes as each
 * section's `id`: punctuation but `_`, `-` and `.` dropped, lowercased, words
 * joined by hyphens, and everything before the first letter cut —
 * `1 · Diamond insulation` is `diamond-insulation`, `8 · 3D model (pastis-NB)`
 * is `d-model-pastis-nb`.
 */
export function pandocId(heading) {
  const words = heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\-.\s]/gu, '')
    .split(/\s+/)
    .filter((word) => word !== '')
  return words.join('-').replace(/^[^\p{L}]+/u, '')
}

/**
 * Each numbered section of `notebooks/validation.qmd` — `## 1 · Diamond
 * insulation` — by its number, as its address on the published page.
 */
export function validationAnchors(qmd) {
  const anchors = {}
  for (const match of qmd.matchAll(/^## (\d+) · (.+)$/gm)) {
    anchors[match[1]] = `${VALIDATION_URL}#${pandocId(`${match[1]} · ${match[2].trim()}`)}`
  }
  return anchors
}

/**
 * The releases in `CHANGELOG.md`, newest first: each `## [x.y.z] - date`
 * section's version, date and body, the body's headings raised one level so
 * that `### Added` is a section of the release's page. `[Unreleased]` comes
 * first where it is asked for and says anything; a section whose date is not
 * one (`0.1.0 - unreleased`, never tagged) has none.
 */
export function changelogReleases(changelog, { unreleased = false } = {}) {
  const text = changelog.replace(/\r\n/g, '\n')
  const heads = [...text.matchAll(/^## \[([^\]]+)\](?:\s*-\s*(.+))?$/gm)]
  const releases = []
  heads.forEach((head, index) => {
    const start = head.index + head[0].length
    const end = index + 1 < heads.length ? heads[index + 1].index : text.length
    const body = text
      .slice(start, end)
      .replace(/^(#{3,5}) /gm, (hashes) => `${hashes.slice(1)}`)
      .trim()
    const name = head[1].trim()
    if (name.toLowerCase() === 'unreleased') {
      if (unreleased && body !== '') releases.push({ version: 'Unreleased', date: null, body })
      return
    }
    const date = /^\d{4}-\d{2}-\d{2}$/.test((head[2] ?? '').trim()) ? head[2].trim() : null
    releases.push({ version: name, date, body })
  })
  return releases
}

/** `2026-11-01` as a reader writes it: `1 November 2026`. */
export function longDate(iso) {
  const [year, month, day] = iso.split('-').map(Number)
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  return `${day} ${months[month - 1]} ${year}`
}

/** The tokens the theme reads, and the `:root` block of the stylesheet each comes from. */
const COLOUR_TOKENS = [
  'bg', 'bg-sunken', 'bg-raised', 'bg-muted', 'border', 'border-strong', 'text', 'text-dim', 'text-faint',
  'accent', 'accent-soft', 'on-accent', 'danger', 'danger-soft', 'ok', 'warn', 'warn-soft', 'shadow-1', 'shadow-2',
]
const SHAPE_TOKENS = ['sans', 'mono', 'radius']

/** The custom properties a rule declares, by name without the dashes. */
function declarations(body) {
  const out = {}
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) out[match[1]] = match[2].replace(/\s+/g, ' ').trim()
  return out
}

/**
 * The app's light and dark palettes and its type and shape, from
 * `src/ui/styles.css`, as the documentation's theme reads them: `--cx-<name>`,
 * the dark palette on `:root` and the light one on `[data-theme='light']`,
 * which is how Starlight spells its two themes (dark is its default). A token
 * the theme reads that the stylesheet no longer declares is an error, not a
 * colour quietly missing from the site.
 */
export function appTokens(css) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1].split(',').map((selector) => selector.trim()),
    tokens: declarations(match[2]),
  }))
  const light = rules.find((rule) => rule.selectors.includes(":root[data-theme='light']") && 'bg' in rule.tokens)
  const dark = rules.find((rule) => rule.selectors.length === 1 && rule.selectors[0] === ":root[data-theme='dark']" && 'bg' in rule.tokens)
  const base = rules.find((rule) => rule.selectors.length === 1 && rule.selectors[0] === ':root' && 'sans' in rule.tokens)
  const missing = []
  for (const [name, rule] of [['light', light], ['dark', dark]]) {
    if (rule === undefined) missing.push(`the ${name} palette`)
    else for (const token of COLOUR_TOKENS) if (!(token in rule.tokens)) missing.push(`--${token} (${name})`)
  }
  if (base === undefined) missing.push('the :root block with --sans')
  else for (const token of SHAPE_TOKENS) if (!(token in base.tokens)) missing.push(`--${token}`)
  if (missing.length > 0) throw new Error(`src/ui/styles.css no longer declares ${missing.join(', ')}`)
  const lines = (rule, names) => names.map((name) => `  --cx-${name}: ${rule.tokens[name]};`).join('\n')
  return [
    '/* Written by scripts/docs-data.mjs from src/ui/styles.css: the app\'s own tokens. Not edited by hand. */',
    ':root,\n::backdrop {',
    lines(dark, COLOUR_TOKENS),
    lines(base, SHAPE_TOKENS),
    '}',
    ":root[data-theme='light'],\n[data-theme='light'] ::backdrop {",
    lines(light, COLOUR_TOKENS),
    '}',
    '',
  ].join('\n')
}

/** A YAML scalar: JSON's double-quoted string is one. */
const yaml = (value) => JSON.stringify(value)

/** A generated page: its front matter, a line saying where it comes from, and its body. */
function frontMatter(fields) {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (value !== null && typeof value === 'object') {
      lines.push(`${key}:`)
      for (const [inner, innerValue] of Object.entries(value)) lines.push(`  ${inner}: ${yaml(innerValue)}`)
    } else lines.push(`${key}: ${typeof value === 'string' ? yaml(value) : String(value)}`)
  }
  lines.push('---', '')
  return lines.join('\n')
}

/** The app's half, through a Vite server of its own (see the docblock). */
async function loadAppData() {
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
    const { docsData } = await server.ssrLoadModule('/src/documentation/data.ts')
    return docsData()
  } finally {
    await server.close()
  }
}

/** Write a file, and the directory it is in. */
function write(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

async function main() {
  const label = process.env.DOCS_VERSION ?? 'dev'
  const dev = label === 'dev'
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const repository = repositoryUrl(manifest)
  const ref = dev ? 'main' : label

  const data = await loadAppData()
  const anchors = validationAnchors(readFileSync(join(ROOT, 'notebooks', 'validation.qmd'), 'utf8'))
  for (const task of data.tasks) {
    const section = task.reference?.section
    if (section !== undefined && anchors[section] === undefined) {
      throw new Error(`${task.id} cites section ${section} of the validation, which notebooks/validation.qmd does not have`)
    }
    if (task.reference !== null) task.reference.validation = section === undefined ? null : anchors[section]
  }

  rmSync(GENERATED, { recursive: true, force: true })
  write(
    join(GENERATED, 'data.json'),
    `${JSON.stringify({ version: manifest.version, repository, ref, tasks: data.tasks, groups: data.groups, inputs: data.inputs, outputs: data.outputs }, null, 2)}\n`,
  )
  write(join(GENERATED, 'tokens.css'), appTokens(readFileSync(join(ROOT, 'src', 'ui', 'styles.css'), 'utf8')))
  copyFileSync(join(ROOT, 'public', 'icon-192.png'), join(GENERATED, 'mark.png'))
  mkdirSync(join(SITE, 'public'), { recursive: true })
  copyFileSync(join(ROOT, 'public', 'icon-192.png'), join(SITE, 'public', 'favicon.png'))

  rmSync(join(CONTENT, 'reference'), { recursive: true, force: true })
  for (const page of data.pages) {
    write(
      join(CONTENT, page.path),
      frontMatter({ title: page.title, description: page.description, editUrl: false }) +
        ':::note[Written from the app]\nThis page is generated from chromosomix’s own code each time the documentation is built, so it is exactly what this version accepts. The same text is served to AI agents, as Markdown, from [chromosomix.app/llms.txt](https://chromosomix.app/llms.txt).\n:::\n\n' +
        page.markdown,
    )
  }

  rmSync(join(CONTENT, 'releases'), { recursive: true, force: true })
  const releases = changelogReleases(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), { unreleased: dev })
  releases.forEach((release, order) => {
    const unreleased = release.version === 'Unreleased'
    const slug = unreleased ? 'releases/unreleased' : `releases/v${release.version}`
    const when = unreleased
      ? 'What has changed on main since the latest release, and will be in the next one.'
      : release.date === null
        ? `What changed in chromosomix ${release.version}.`
        : `What changed in chromosomix ${release.version}, released on ${longDate(release.date)}.`
    write(
      join(CONTENT, `${slug}.md`),
      frontMatter({
        title: unreleased ? 'Unreleased' : `chromosomix ${release.version}`,
        description: when,
        slug,
        sidebar: { label: unreleased ? 'Unreleased' : release.version, order },
        editUrl: false,
        pagefind: false,
      }) + `${when}\n\n${absoluteLinks(release.body, repository, ref)}\n`,
    )
  })

  console.log(
    `docs data: ${data.tasks.length} tasks, ${data.pages.length} reference pages, ${releases.length} release notes, ` +
      `tokens and mark, for ${dev ? 'main' : label}`,
  )
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
