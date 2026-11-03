/**
 * The documentation site of chromosomix (SPECS §32): Astro and Starlight, with
 * the Rapide theme under the app's own look (`src/styles/chromosomix.css`).
 *
 * One config for every copy. Which copy — `dev`, a release, or the latest
 * release again at the root — is the environment's to say (`src/lib/site.mjs`),
 * and the docs workflow builds each with the base it is published under.
 *
 * Everything under `src/generated/`, and the pages under `reference/` and
 * `releases/`, is written by `node ../scripts/docs-data.mjs` from the app's
 * source before the build (`npm run build` runs it first).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { satteri } from '@astrojs/markdown-satteri'
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightLinksValidator from 'starlight-links-validator'
import starlightThemeRapide from 'starlight-theme-rapide'

import { baseLinks, scrollingTables } from './src/lib/base-links.mjs'
import { trueSizeScreens } from './src/lib/screens.mjs'
import { sidebar } from './src/lib/sidebar.mjs'
import { BASE, IS_DEV, REPOSITORY, SITE, VALIDATE_LINKS } from './src/lib/site.mjs'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))

const dataFile = here('./src/generated/data.json')
if (!existsSync(dataFile)) {
  throw new Error('src/generated/data.json is missing: run `npm run data` (node ../scripts/docs-data.mjs) first')
}
const data = JSON.parse(readFileSync(dataFile, 'utf8'))

// Every task has a page, and every page under analyses/ is a task's or one of
// the two guides: a task added to the registry without one, or a page left
// behind by a task that was removed, stops the build here.
const taskIds = new Set(data.tasks.map((task) => task.id))
const pages = new Set(
  readdirSync(here('./src/content/docs/analyses'))
    .filter((name) => /\.mdx?$/.test(name))
    .map((name) => name.replace(/\.mdx?$/, '')),
)
const missing = [...taskIds].filter((id) => !pages.has(id))
const stray = [...pages].filter((name) => !taskIds.has(name) && name !== 'index' && name !== 'validation')
if (missing.length > 0 || stray.length > 0) {
  throw new Error(
    [
      missing.length > 0 ? `tasks with no page under src/content/docs/analyses/: ${missing.join(', ')}` : '',
      stray.length > 0 ? `pages under src/content/docs/analyses/ that are no task's: ${stray.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; '),
  )
}

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'always',
  markdown: { processor: satteri({ hastPlugins: [baseLinks, scrollingTables, trueSizeScreens] }) },
  integrations: [
    starlight({
      title: 'chromosomix',
      description:
        'How to use chromosomix: the genome browser for Hi-C and Micro-C contact maps, genome tracks and 3D models, and the command line that runs its analyses.',
      logo: { src: './src/generated/mark.png', alt: '' },
      favicon: '/favicon.png',
      head: IS_DEV ? [{ tag: 'meta', attrs: { name: 'robots', content: 'noindex' } }] : [],
      editLink: { baseUrl: `${REPOSITORY}/edit/main/documentation/` },
      lastUpdated: false,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      customCss: ['./src/generated/tokens.css', './src/styles/chromosomix.css'],
      expressiveCode: { defaultProps: { wrap: true } },
      components: {
        Banner: './src/components/Banner.astro',
        Footer: './src/components/Footer.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        SocialIcons: './src/components/SocialIcons.astro',
      },
      routeMiddleware: './src/lib/route-data.ts',
      plugins: [starlightThemeRapide(), ...(VALIDATE_LINKS ? [starlightLinksValidator({ errorOnRelativeLinks: true })] : [])],
      sidebar: sidebar(data),
    }),
  ],
})
