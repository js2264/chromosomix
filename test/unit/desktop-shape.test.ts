/**
 * The shape a packaged renderer has to have.
 *
 * Every rule under test here fails *late* and *quietly* when it is broken: the
 * build succeeds, the installer is produced, CI is green, and the application
 * misbehaves on a machine that has no console open. A blank window, a hang on
 * "Opening…", an installer a quarter of a gigabyte too large — none of them
 * arrive as an error message, which is exactly why the rules are a pure module
 * with a test rather than three greps in a shell script.
 *
 * `check-desktop-build.mjs` does the walking; this pins what it decides.
 */

import { describe, expect, it } from 'vitest'

import {
  DATA_EXTENSIONS,
  entryChunkProblems,
  indexHtmlProblems,
  isDataFile,
  preloadProblems,
  rendererFileProblems,
} from '../../scripts/desktop-shape.mjs'

/** What `vite build --config vite.desktop.config.ts` should produce. */
const GOOD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <link rel="icon" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" />
    <script type="module" crossorigin src="./assets/index-kX9qOJF.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-Bt9PlzW3.css" />
  </head>
  <body><div id="app"></div></body>
</html>`

describe('indexHtmlProblems', () => {
  it('passes a build whose URLs are relative', () => {
    expect(indexHtmlProblems(GOOD_HTML)).toEqual([])
  })

  it('catches a root-absolute base, which is a blank window and no error', () => {
    const html = GOOD_HTML.replace('./assets/index-kX9qOJF.js', '/assets/index-kX9qOJF.js')
    const problems = indexHtmlProblems(html)
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('no relative module script')
    expect(problems[1]).toContain('/assets/index-kX9qOJF.js')
  })

  it('catches a stylesheet left at the root even when the script is right', () => {
    const html = GOOD_HTML.replace('./assets/index-Bt9PlzW3.css', '/assets/index-Bt9PlzW3.css')
    expect(indexHtmlProblems(html)).toEqual([expect.stringContaining('/assets/index-Bt9PlzW3.css')])
  })

  it('catches a surviving manifest link', () => {
    const html = GOOD_HTML.replace(
      '<meta charset="utf-8" />',
      '<meta charset="utf-8" />\n    <link rel="manifest" href="./manifest.webmanifest" />',
    )
    expect(indexHtmlProblems(html)).toEqual([expect.stringContaining('web manifest')])
  })

  it('does not mistake the data-URI favicon for a root reference', () => {
    // `href="data:image/svg+xml,…"` contains slashes and lives in every build;
    // a rule matching on "starts with a slash somewhere" flags it forever.
    expect(indexHtmlProblems(GOOD_HTML)).toEqual([])
  })

  it('notices a build that emitted no module script at all', () => {
    const html = '<!doctype html><html><head></head><body></body></html>'
    expect(indexHtmlProblems(html)).toEqual([expect.stringContaining('no relative module script')])
  })
})

describe('entryChunkProblems', () => {
  it('passes a chunk whose worker URL is relative to the module', () => {
    const source = 'new Worker(new URL("./reader.worker-AYfpflMn.js",import.meta.url),{type:"module"})'
    expect(entryChunkProblems(source)).toEqual([])
  })

  it('catches a root-absolute worker URL, which hangs on "Opening…"', () => {
    // The failure this exists for: `index.html` is fine, the shell renders, the
    // picker appears, and the first file opened never finishes.
    const source =
      'new Worker(new URL("/assets/reader.worker-AYfpflMn.js",import.meta.url),{type:"module"})'
    expect(entryChunkProblems(source)).toEqual([
      expect.stringContaining('/assets/reader.worker-AYfpflMn.js'),
    ])
  })

  it('reports every worker separately, not just the first', () => {
    const source =
      'new URL("/assets/reader.worker-a.js",import.meta.url);new URL("/assets/annotations.worker-b.js",import.meta.url)'
    expect(entryChunkProblems(source)).toHaveLength(2)
  })
})

describe('isDataFile', () => {
  it('knows the text formats, which a binary-shaped rule would let through', () => {
    for (const name of [
      'Yeast_annotations.gtf',
      'Yeast_microC_loops.tsv',
      'Yeast_ATAC.narrowPeak',
      'contacts.pairs',
    ]) {
      expect(isDataFile(name), name).toBe(true)
    }
  })

  it('knows the maps and the tracks', () => {
    for (const name of [
      'Mock_microbial_community.metacool',
      'Mock_microbial_community.mmetacool',
      'Ecoli.mcool',
      'Yeast_microC_G2M_1kb.cool',
      'Yeast_MNase.bw',
      'Yeast_MNase.bigWig',
    ]) {
      expect(isDataFile(name), name).toBe(true)
    }
  })

  it('is case-insensitive, because `.BW` is the same 46 MB', () => {
    expect(isDataFile('Yeast_MNase.BW')).toBe(true)
    expect(isDataFile('Ecoli.MCOOL')).toBe(true)
  })

  it('leaves the application alone', () => {
    for (const name of ['index.html', 'assets/index-kX9qOJF.js', 'assets/index-Bt9PlzW3.css']) {
      expect(isDataFile(name), name).toBe(false)
    }
  })

  it('names every extension the package guard also uses', () => {
    // The two lists must not drift: `electron-builder.config.cjs` writes the
    // same set as a negated glob, and `check-package.mjs` reads this one.
    expect(DATA_EXTENSIONS).toContain('.metacool')
    expect(DATA_EXTENSIONS).toContain('.tsv')
  })
})

describe('preloadProblems', () => {
  const BUNDLED =
    'var CHANNEL_COMMAND="metacooler:command";var electron=require("electron");' +
    'electron.contextBridge.exposeInMainWorld("metacoolerDesktop",{platform:{},onCommand(h){}});'

  it('passes a bundled preload that requires only electron', () => {
    expect(preloadProblems(BUNDLED)).toEqual([])
  })

  it('catches the relative require tsc emits, which no runtime error explains', () => {
    // The actual regression: `tsc` emits correct CommonJS that a sandboxed
    // preload cannot load. The app starts, the window opens, the page renders,
    // the menu appears, and every item does nothing.
    const source = 'const contract_cjs_1 = require("./contract.cjs");' + BUNDLED
    expect(preloadProblems(source)).toEqual([expect.stringContaining('./contract.cjs')])
  })

  it('catches a parent-relative require too', () => {
    expect(preloadProblems(`require("../shared/x.cjs");${BUNDLED}`)).toEqual([
      expect.stringContaining('../shared/x.cjs'),
    ])
  })

  it('leaves bare built-in requires alone', () => {
    expect(preloadProblems(`require("node:events");${BUNDLED}`)).toEqual([])
  })

  it('notices a preload that exposes nothing at all', () => {
    expect(preloadProblems('var x = 1')).toEqual([
      expect.stringContaining('exposeInMainWorld'),
    ])
  })
})

describe('rendererFileProblems', () => {
  it('passes a build that is only the app', () => {
    expect(
      rendererFileProblems([
        'index.html',
        'assets/index-kX9qOJF.js',
        'assets/index-Bt9PlzW3.css',
        'assets/reader.worker-NrqI6RmA.js',
        'assets/hdf5_hl-8FoHa7pu.js',
      ]),
    ).toEqual([])
  })

  it('catches a service worker, which three guards were supposed to prevent', () => {
    expect(rendererFileProblems(['index.html', 'sw.js'])).toEqual([
      expect.stringContaining('service worker'),
    ])
  })

  it('catches a web manifest', () => {
    expect(rendererFileProblems(['manifest.webmanifest'])).toEqual([
      expect.stringContaining('web manifest'),
    ])
  })

  it('catches the demo directory by path, not only by extension', () => {
    // The directory is the rule: a README or a checksum file under `demo/` is
    // still 250 MB of neighbours that came with it.
    expect(rendererFileProblems(['demo/README.md'])).toEqual([
      expect.stringContaining('demo directory'),
    ])
  })

  it('catches a data file anywhere, including outside demo/', () => {
    expect(rendererFileProblems(['assets/Ecoli.mcool'])).toEqual([
      expect.stringContaining('data file'),
    ])
  })

  it('reports every problem rather than stopping at the first', () => {
    // The operator has to fix them all; a check that names one of four turns
    // one build into four.
    expect(rendererFileProblems(['sw.js', 'manifest.webmanifest', 'demo/Ecoli.mcool'])).toHaveLength(
      3,
    )
  })
})
