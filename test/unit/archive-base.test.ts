/**
 * Moving archived builds to the site's base.
 *
 * Every build on the `pages-archive` branch was built for the address the site
 * had when it was pushed, and the day the site moves — to a custom domain, to a
 * renamed repository — each of them is a blank page at its new address: Vite
 * baked the old base into every asset URL. `scripts/archive-rebase.mjs` rewrites
 * them once, on the deploy after the move, by the rules held here. The strings
 * below are what the archived builds actually contain.
 */

import { describe, expect, it } from 'vitest'

import { bakedSiteBase, isBuildDirectory, isTextAsset, rebaseText } from '../../scripts/archive-base.mjs'

/** The head of an archived build's `index.html`, as the archive holds it. */
const INDEX =
  '<script type="module" crossorigin src="/metacooler.js/v/5bbff1e/assets/index-Dz-5Fsc7.js"></script>\n' +
  '<link rel="stylesheet" crossorigin href="/metacooler.js/v/5bbff1e/assets/index-7c4dV3C6.css">'

/** Pieces of an archived bundle that name its base. */
const BUNDLE = [
  'navigator.serviceWorker.register("/metacooler.js/v/5bbff1e/sw.js",{updateViaCache:"none"})',
  'new Worker(new URL("/metacooler.js/v/5bbff1e/assets/reader.worker-C6W0gl1H.js",import.meta.url),{type:"module"})',
  'const ab=OF("/metacooler.js/v/5bbff1e/"),ui=ab.site',
  // An older build's site root, kept on its own before `BASE_URL` gave it.
  'const Xr="/metacooler.js/"',
  // The site's absolute address, which is not a base and must not move.
  'H5="https://js2264.github.io/metacooler.js/"',
  // Text that merely mentions a path, which no rule may touch.
  'a slash "/" and the root "/" of anything',
].join(';')

const MOVE = { from: '/metacooler.js/', to: '/', kind: 'v', name: '5bbff1e' } as const

describe('bakedSiteBase', () => {
  it('reads the site a build was made for off its own entry script', () => {
    expect(bakedSiteBase(INDEX, 'v', '5bbff1e')).toBe('/metacooler.js/')
  })

  it('reads a preview the same way', () => {
    const preview = '<script type="module" crossorigin src="/metacooler.js/pr/105/assets/index-B1.js"></script>'
    expect(bakedSiteBase(preview, 'pr', '105')).toBe('/metacooler.js/')
  })

  it('reads a build made for the root of a domain', () => {
    const atRoot = '<script type="module" crossorigin src="/v/5bbff1e/assets/index-Dz-5Fsc7.js"></script>'
    expect(bakedSiteBase(atRoot, 'v', '5bbff1e')).toBe('/')
  })

  it('says nothing about a page that names no asset of its own directory', () => {
    const alias = '<meta http-equiv="refresh" content="0; url=../7a6fea2/" />'
    expect(bakedSiteBase(alias, 'v', 'v0.13.0')).toBeNull()
    expect(bakedSiteBase(INDEX, 'v', '7a6fea2')).toBeNull()
  })
})

describe('rebaseText', () => {
  it('moves every URL under the build to the new site', () => {
    const out = rebaseText(BUNDLE, MOVE)
    expect(out).toContain('register("/v/5bbff1e/sw.js"')
    expect(out).toContain('new URL("/v/5bbff1e/assets/reader.worker-C6W0gl1H.js"')
    expect(out).toContain('OF("/v/5bbff1e/")')
    expect(out).not.toContain('/metacooler.js/v/')
    expect(rebaseText(INDEX, MOVE)).toContain('src="/v/5bbff1e/assets/index-Dz-5Fsc7.js"')
  })

  it('moves an older build’s own copy of the site root', () => {
    expect(rebaseText(BUNDLE, MOVE)).toContain('const Xr="/"')
  })

  it('leaves the site’s absolute address and every unrelated slash alone', () => {
    const out = rebaseText(BUNDLE, MOVE)
    expect(out).toContain('H5="https://js2264.github.io/metacooler.js/"')
    expect(out).toContain('a slash "/" and the root "/" of anything')
  })

  it('touches only the build it is moving', () => {
    const other = 'import("/metacooler.js/v/7a6fea2/assets/x.js")'
    expect(rebaseText(other, MOVE)).toBe(other)
  })

  it('is a no-op for a build already at the site’s base, and idempotent', () => {
    expect(rebaseText(BUNDLE, { ...MOVE, to: '/metacooler.js/' })).toBe(BUNDLE)
    const once = rebaseText(BUNDLE, MOVE)
    expect(rebaseText(once, MOVE)).toBe(once)
  })

  it('moves a build made for the root onto a sub-path without touching a quoted root', () => {
    const atRoot = 'register("/v/5bbff1e/sw.js");const s="/"'
    const out = rebaseText(atRoot, { from: '/', to: '/chromosomix/', kind: 'v', name: '5bbff1e' })
    expect(out).toBe('register("/chromosomix/v/5bbff1e/sw.js");const s="/"')
  })
})

describe('what the walk visits', () => {
  it('takes builds and previews, and leaves release aliases to their relative redirect', () => {
    expect(isBuildDirectory('v', '5bbff1e')).toBe(true)
    expect(isBuildDirectory('v', 'v0.13.0')).toBe(false)
    expect(isBuildDirectory('pr', '105')).toBe(true)
    expect(isBuildDirectory('pr', '0')).toBe(false)
  })

  it('rewrites text and leaves images alone', () => {
    expect(isTextAsset('index.html')).toBe(true)
    expect(isTextAsset('assets/index-Dz-5Fsc7.js')).toBe(true)
    expect(isTextAsset('assets/index-7c4dV3C6.css')).toBe(true)
    expect(isTextAsset('icon-192.png')).toBe(false)
  })
})
