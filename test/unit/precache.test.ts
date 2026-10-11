/**
 * What the service worker precaches — the one thing about it a test can hold.
 *
 * The worker itself needs a browser, a registration and a second page load to
 * do anything at all, so it is verified by driving a real one (see the note in
 * `docs/deploy.md`). What *can* be pinned here is the list it is built with,
 * and that list is where the two failure modes live:
 *
 * - **too little** — a chunk missing from the precache is an app that half
 *   loads on a train, with an error nobody can reproduce on a desk;
 * - **too much** — the demo datasets and track resources are 250 MB, and a
 *   precache that swept them in would turn every first visit into a download of
 *   every file the site ships, silently, in the background.
 *
 * Both are invisible until they are in front of a user, which is exactly the
 * kind of thing to assert about a pure function instead.
 */

import { describe, expect, it } from 'vitest'

import { SHELL_PUBLIC_FILES, isShellAsset, precacheUrls } from '../../scripts/sw-manifest.mjs'

/** A realistic build: hashed chunks, their maps, the css, the html. */
const BUNDLE = [
  'index.html',
  'assets/index-CAiSlBsc.js',
  'assets/index-CAiSlBsc.js.map',
  'assets/index-C-WG60gt.css',
  'assets/reader.worker-AYfpflMn.js',
  'assets/reader.worker-AYfpflMn.js.map',
  'assets/hdf5_hl-8FoHa7pu.js',
]

describe('isShellAsset', () => {
  it('takes the code, the styles and the shell', () => {
    expect(isShellAsset('assets/index-CAiSlBsc.js')).toBe(true)
    expect(isShellAsset('assets/index-C-WG60gt.css')).toBe(true)
    expect(isShellAsset('index.html')).toBe(true)
    // The worker and the HDF5 build are not optional extras: without them the
    // app loads offline and can open nothing.
    expect(isShellAsset('assets/reader.worker-AYfpflMn.js')).toBe(true)
    expect(isShellAsset('assets/hdf5_hl-8FoHa7pu.js')).toBe(true)
  })

  it('leaves out source maps, which are 12 MB and are fetched by devtools', () => {
    expect(isShellAsset('assets/index-CAiSlBsc.js.map')).toBe(false)
  })

  it('leaves out data, whatever it is called', () => {
    // These never reach the function — `public/` is copied outside the bundle —
    // but the rule is the point, and a future build that emits one of them must
    // not sweep it in.
    for (const name of [
      'demo/Ecoli.mcool',
      'demo/Mock_microbial_community.metacool',
      'demo/Yeast_mpneumoniae_G2M.mcool',
      'demo/Yeast_microC_G2M_1kb.cool',
      // The M6 track resources. The text ones are what to watch: a rule
      // written around "binary is data" would take a `.gtf`, a `.tsv` and a
      // `.narrowPeak` straight into the precache.
      'demo/Yeast_MNase.bw',
      'demo/Yeast_annotations.gtf',
      'demo/Yeast_microC_loops.tsv',
      'demo/Yeast_ATAC.narrowPeak',
      'icon-512.png',
    ]) {
      expect(isShellAsset(name), name).toBe(false)
    }
  })
})

describe('precacheUrls', () => {
  it('leads with the navigation URL, which is what a reload asks for', () => {
    expect(precacheUrls(BUNDLE, '/')[0]).toBe('/')
  })

  it('names index.html once — as the base, not twice', () => {
    const urls = precacheUrls(BUNDLE, '/')
    expect(urls.filter((url) => url.endsWith('index.html'))).toEqual([])
    expect(urls).toContain('/')
  })

  it('writes every URL under the base the site is served from', () => {
    const urls = precacheUrls(BUNDLE, '/chromosomix/')
    expect(urls[0]).toBe('/chromosomix/')
    expect(urls).toContain('/chromosomix/assets/index-CAiSlBsc.js')
    // The sub-path case is the one that fails silently: a worker asking for
    // `/assets/…` on a project site installs against four 404s.
    expect(urls.every((url) => url.startsWith('/chromosomix/'))).toBe(true)
  })

  it('tolerates a base with no trailing slash', () => {
    expect(precacheUrls(['assets/a.js'], '/sub').slice(0, 2)).toEqual(['/sub/', '/sub/assets/a.js'])
  })

  it('is stable, so two builds of one tree produce one list', () => {
    const shuffled = [...BUNDLE].reverse()
    expect(precacheUrls(shuffled, '/')).toEqual(precacheUrls(BUNDLE, '/'))
  })

  it('holds only the app: no maps, no data', () => {
    const urls = precacheUrls(BUNDLE, '/')
    expect(urls.some((url) => url.endsWith('.map'))).toBe(false)
    expect(urls.some((url) => url.includes('/demo/'))).toBe(false)
    // The navigation URL, four built assets (the two maps and index.html are
    // out), and the public shell.
    expect(urls).toHaveLength(1 + 4 + SHELL_PUBLIC_FILES.length)
  })

  it('takes the manifest and the icons, which `public/` keeps out of the bundle', () => {
    // Found by cutting the network and reloading: everything worked except a
    // failed request for the manifest, because it is copied rather than built
    // and so was never in the list the bundle could offer.
    const urls = precacheUrls(BUNDLE, '/chromosomix/')
    expect(urls).toContain('/chromosomix/manifest.webmanifest')
    expect(urls).toContain('/chromosomix/icon-192.png')
    expect(urls).toContain('/chromosomix/icon-512.png')
    expect(urls).toContain('/chromosomix/apple-touch-icon.png')
  })
})
